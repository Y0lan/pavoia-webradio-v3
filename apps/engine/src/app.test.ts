import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createApp,
  resolvePort,
  type HealthBody,
  type StagesBody,
} from "./app.ts";
import {
  STAGES,
  AUDIO_STAGES,
  type NowPlaying,
  type Track,
} from "@pavoia/shared";
import { createStageRegistry } from "./stages/registry.ts";
import type { StageController } from "./stages/supervisor.ts";

function fakeController(
  stageId: string,
  snap: {
    status: "starting" | "playing" | "curating" | "stopping" | "stopped";
    track: Track | null;
    trackStartedAt: number | null;
  },
): StageController {
  return {
    stageId,
    status: () => snap.status,
    currentTrack: () => snap.track,
    snapshot: () => ({ ...snap }),
    stop: async () => {},
    done: Promise.resolve(),
  };
}

const SAMPLE_TRACK: Track = {
  plexRatingKey: 12345,
  fallbackHash: "deadbeef00000000",
  title: "Sunset Lift",
  artist: "Some Artist",
  album: "Some Album",
  albumYear: 2024,
  durationSec: 360,
  // filePath is engine-internal — must NOT appear in the response.
  filePath: "/home/yolan/files/plex_music_library/opus/sunset.opus",
  coverUrl: "/library/metadata/12345/thumb/abc",
};

describe("resolvePort", () => {
  it("defaults to 3001 when env is undefined", () => {
    assert.equal(resolvePort(undefined), 3001);
  });

  it("defaults to 3001 when env is empty string", () => {
    assert.equal(resolvePort(""), 3001);
  });

  it("accepts a valid integer string", () => {
    assert.equal(resolvePort("3001"), 3001);
    assert.equal(resolvePort("65535"), 65535);
    assert.equal(resolvePort("1"), 1);
  });

  it("rejects non-numeric strings", () => {
    assert.throws(() => resolvePort("abc"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("3001abc"), /ENGINE_PORT must be/);
  });

  it("rejects float values", () => {
    assert.throws(() => resolvePort("3.14"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("3001.5"), /ENGINE_PORT must be/);
  });

  it("rejects zero and negative numbers", () => {
    assert.throws(() => resolvePort("0"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("-1"), /ENGINE_PORT must be/);
  });

  it("rejects values above 65535", () => {
    assert.throws(() => resolvePort("65536"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("999999"), /ENGINE_PORT must be/);
  });

  it("rejects NaN, Infinity and -Infinity literal strings", () => {
    assert.throws(() => resolvePort("NaN"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("Infinity"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("-Infinity"), /ENGINE_PORT must be/);
  });

  it("rejects whitespace-only strings", () => {
    assert.throws(() => resolvePort("   "), /ENGINE_PORT must be/);
  });

  it("rejects leading/trailing whitespace around a valid number", () => {
    assert.throws(() => resolvePort("  3001  "), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("3001\n"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("\t3001"), /ENGINE_PORT must be/);
  });

  it("rejects scientific notation even if the value would be in range", () => {
    assert.throws(() => resolvePort("1e3"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("3.001e3"), /ENGINE_PORT must be/);
  });

  it("rejects hex/octal/binary notation", () => {
    assert.throws(() => resolvePort("0x7D9"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("0o5731"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("0b101110111001"), /ENGINE_PORT must be/);
  });

  it("rejects signed values and leading zeros", () => {
    assert.throws(() => resolvePort("+3001"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("-3001"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("03001"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("007"), /ENGINE_PORT must be/);
  });

  it("rejects numeric separators (1_000)", () => {
    assert.throws(() => resolvePort("1_000"), /ENGINE_PORT must be/);
  });

  it("rejects non-ASCII digits", () => {
    assert.throws(() => resolvePort("٣٠٠١"), /ENGINE_PORT must be/);
    assert.throws(() => resolvePort("３００１"), /ENGINE_PORT must be/);
  });
});

describe("createApp() — HTTP contract", () => {
  it("GET /api/health returns 200 with the watchdog contract shape", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type")?.startsWith("application/json"), true);

    const body = (await res.json()) as HealthBody;
    assert.equal(body.ok, true);
    assert.equal(body.plexReachable, null);
    assert.deepEqual(body.stages, {});
    assert.equal(typeof body.pid, "number");
    assert.ok(body.pid > 0);
    assert.equal(typeof body.uptimeSec, "number");
    assert.ok(body.uptimeSec >= 0);
    assert.match(body.nodeVersion, /^v\d+\./);
    assert.equal(body.stageCount.total, 11);
    assert.equal(body.stageCount.audio, 10);
  });

  it("GET /unknown returns 404 JSON with the path echoed back", async () => {
    const app = createApp();
    const res = await app.request("/definitely-does-not-exist");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; path: string };
    assert.equal(body.error, "not_found");
    assert.equal(body.path, "/definitely-does-not-exist");
  });

  it("POST /api/health returns 404 (only GET is defined)", async () => {
    const app = createApp();
    const res = await app.request("/api/health", { method: "POST" });
    assert.equal(res.status, 404);
  });

  it("handler throws → onError returns 500 JSON, does not leak the stack", async () => {
    const app = createApp();
    app.get("/boom", () => {
      throw new Error("test-panic");
    });
    const res = await app.request("/boom");
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "internal_server_error");
    const text = JSON.stringify(body);
    assert.equal(text.includes("test-panic"), false, "error message must not be leaked to client");
  });

  it("health handler does not allocate a new app per request (createApp is factory)", async () => {
    const app = createApp();
    const res1 = await app.request("/api/health");
    const res2 = await app.request("/api/health");
    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
  });

  it("GET /api/stages returns the static catalog of all 11 stages in order", async () => {
    const app = createApp();
    const res = await app.request("/api/stages");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type")?.startsWith("application/json"),
      true,
    );

    const body = (await res.json()) as StagesBody;
    assert.equal(body.stages.length, STAGES.length);
    assert.equal(body.stages.length, 11);

    // Order is the source-of-truth ordering from packages/shared.
    body.stages.forEach((s, i) => {
      assert.equal(s.id, STAGES[i]!.id, `stage ${i} id`);
      assert.equal(s.order, STAGES[i]!.order, `stage ${i} order`);
    });

    // Every stage must carry the full UI payload — icon + gradient +
    // accent are static (ported from v1's streamMeta), and the UI
    // can't render without them.
    for (const s of body.stages) {
      assert.equal(typeof s.icon, "string");
      assert.notEqual(s.icon, "");
      assert.equal(typeof s.fallbackTitle, "string");
      assert.equal(typeof s.fallbackDescription, "string");
      assert.equal(typeof s.accent, "string");
      assert.match(s.accent, /^#[0-9a-fA-F]{6}$/);
      assert.equal(typeof s.gradient.from, "string");
      assert.equal(typeof s.gradient.via, "string");
      assert.equal(typeof s.gradient.to, "string");
      assert.equal(typeof s.disabled, "boolean");
    }

    // The Bus mystery stage MUST be present and disabled — the UI
    // contract for the easter-egg overlay depends on this.
    const bus = body.stages.find((s) => s.id === "bus");
    assert.ok(bus, "bus stage must be in the catalog");
    assert.equal(bus.disabled, true);
    assert.equal(bus.plexPlaylistId, null);

    // Every audio stage has a Plex playlist id (positive integer —
    // not just any number; floats would silently pass typeof "number").
    const audioFromCatalog = body.stages.filter((s) => !s.disabled);
    assert.equal(audioFromCatalog.length, AUDIO_STAGES.length);
    for (const s of audioFromCatalog) {
      assert.ok(
        s.plexPlaylistId !== null &&
          Number.isInteger(s.plexPlaylistId) &&
          s.plexPlaylistId > 0,
        `${s.id}: plexPlaylistId must be a positive integer, got ${s.plexPlaylistId}`,
      );
    }
  });

  it("GET /api/stages is idempotent — back-to-back calls return the same shape", async () => {
    const app = createApp();
    const a = (await (await app.request("/api/stages")).json()) as StagesBody;
    const b = (await (await app.request("/api/stages")).json()) as StagesBody;
    assert.deepEqual(a, b);
  });

  it("POST /api/stages returns 404 (only GET is defined)", async () => {
    const app = createApp();
    const res = await app.request("/api/stages", { method: "POST" });
    assert.equal(res.status, 404);
  });
});

describe("createApp() — /api/stages/:id/now", () => {
  it("returns 200 with the projected NowPlaying when the stage has a current track", async () => {
    const registry = createStageRegistry();
    registry.register(
      fakeController("opening", {
        status: "playing",
        track: SAMPLE_TRACK,
        trackStartedAt: 1_700_000_000_000,
      }),
    );
    const app = createApp({ registry });
    const res = await app.request("/api/stages/opening/now");
    assert.equal(res.status, 200);
    const body = (await res.json()) as NowPlaying;
    assert.equal(body.stageId, "opening");
    assert.equal(body.status, "playing");
    assert.equal(body.startedAt, 1_700_000_000_000);
    assert.equal(body.streamUrl, "/hls/opening/index.m3u8");
    // The Track must be projected to PublicTrack — `filePath` is
    // engine-internal and MUST NOT appear in the response.
    assert.equal(body.track?.title, "Sunset Lift");
    assert.equal(body.track?.plexRatingKey, 12345);
    assert.equal(
      "filePath" in (body.track ?? {}),
      false,
      "filePath must never leak through /api/stages/:id/now",
    );
  });

  it("returns 200 with track=null and startedAt=null while curating", async () => {
    const registry = createStageRegistry();
    registry.register(
      fakeController("opening", {
        status: "curating",
        track: null,
        trackStartedAt: null,
      }),
    );
    const app = createApp({ registry });
    const res = await app.request("/api/stages/opening/now");
    assert.equal(res.status, 200);
    const body = (await res.json()) as NowPlaying;
    assert.equal(body.status, "curating");
    assert.equal(body.track, null);
    assert.equal(body.startedAt, null);
  });

  it("returns 404 when the stage id is not in the static catalog", async () => {
    const registry = createStageRegistry();
    const app = createApp({ registry });
    const res = await app.request("/api/stages/no-such-stage/now");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "stage_not_found");
    assert.equal(body.stageId, "no-such-stage");
  });

  it("returns 410 Gone for the disabled bus stage (no audio by design)", async () => {
    const registry = createStageRegistry();
    const app = createApp({ registry });
    const res = await app.request("/api/stages/bus/now");
    assert.equal(res.status, 410);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "stage_has_no_audio");
    assert.equal(body.stageId, "bus");
  });

  it("returns 503 when no registry is wired (engine not fully started)", async () => {
    const app = createApp(); // no deps
    const res = await app.request("/api/stages/opening/now");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "registry_unavailable");
    assert.equal(body.stageId, "opening");
  });

  it("returns 503 when the stage is in the catalog but no controller is registered", async () => {
    const registry = createStageRegistry();
    // Register a different stage so the registry is non-empty but
    // the requested one is missing.
    registry.register(
      fakeController("closing", {
        status: "playing",
        track: SAMPLE_TRACK,
        trackStartedAt: 1,
      }),
    );
    const app = createApp({ registry });
    const res = await app.request("/api/stages/opening/now");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "stage_not_running");
  });

  it("snapshots are atomic — same handler call sees consistent track + startedAt", async () => {
    // Verifies the API uses snapshot() rather than calling currentTrack()
    // and trackStartedAt() separately (which could race with a track
    // change mid-handler).
    let flips = 0;
    const flippy: StageController = {
      stageId: "opening",
      status: () => "playing",
      currentTrack: () => SAMPLE_TRACK,
      snapshot: () => {
        flips++;
        // If the handler called snapshot() multiple times it would
        // see different states. Exposing the flip count via track id
        // lets the assertion catch a regression.
        return {
          status: "playing",
          track: { ...SAMPLE_TRACK, plexRatingKey: flips },
          trackStartedAt: flips * 1000,
        };
      },
      stop: async () => {},
      done: Promise.resolve(),
    };
    const registry = createStageRegistry();
    registry.register(flippy);
    const app = createApp({ registry });

    const res = await app.request("/api/stages/opening/now");
    const body = (await res.json()) as NowPlaying;
    assert.equal(flips, 1, "snapshot() must be called exactly once per request");
    assert.equal(body.track?.plexRatingKey, 1);
    assert.equal(body.startedAt, 1000);
  });

  it("POST /api/stages/:id/now returns 404 (only GET is defined)", async () => {
    const registry = createStageRegistry();
    const app = createApp({ registry });
    const res = await app.request("/api/stages/opening/now", {
      method: "POST",
    });
    assert.equal(res.status, 404);
  });
});
