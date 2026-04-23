import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Stage, Track } from "@pavoia/shared";

import { bootstrap } from "./bootstrap.ts";
import type { EngineConfig } from "./config.ts";
import type {
  FetchPlaylistResult,
  PlexApiError,
  PlexClient,
} from "./plex/client.ts";
import type {
  StageController,
  StageEvent,
  StartStageConfig,
} from "./stages/supervisor.ts";

const BASE_CONFIG: EngineConfig = {
  port: 3001,
  plexBaseUrl: "http://127.0.0.1:31711",
  plexToken: "tok",
  libraryRoot: "/lib",
  hlsRoot: "/dev/shm/1008/radio-hls",
  fallbackFile: "/curating.aac",
  ffmpegBin: "ffmpeg",
  plexPollIntervalMs: 60_000,
};

function makeTrack(plexRatingKey: number): Track {
  return {
    plexRatingKey,
    fallbackHash: `h-${plexRatingKey}`,
    title: `t${plexRatingKey}`,
    artist: "a",
    album: "b",
    albumYear: null,
    durationSec: 60,
    filePath: `/m/${plexRatingKey}.opus`,
    coverUrl: null,
  };
}

function fakeStage(
  id: string,
  plexPlaylistId: number | null,
  disabled = false,
): Stage {
  return {
    id: id as Stage["id"],
    order: 0,
    plexPlaylistId,
    icon: "🎵",
    fallbackTitle: id,
    fallbackDescription: "",
    gradient: { from: "#000", via: "#000", to: "#000" },
    accent: "#fff",
    disabled,
  };
}

interface FakeStageController extends StageController {
  stopped: boolean;
  config: StartStageConfig;
}

function fakeStartStageFactory() {
  const created: FakeStageController[] = [];
  function fakeStartStage(config: StartStageConfig): StageController {
    const ctl: FakeStageController = {
      stageId: config.stageId,
      stopped: false,
      config,
      status: () => (ctl.stopped ? "stopped" : "playing"),
      currentTrack: () => null,
      snapshot: () => ({
        status: ctl.stopped ? "stopped" : "playing",
        track: null,
        trackStartedAt: null,
      }),
      stop: async () => {
        ctl.stopped = true;
      },
      done: Promise.resolve(),
    };
    created.push(ctl);
    return ctl;
  }
  return { fakeStartStage, created };
}

interface ScriptedPlex {
  client: PlexClient;
  setNext(
    playlistId: number,
    response: Track[] | { error: PlexApiError },
  ): void;
  fetchCalls: number[];
}

function scriptedPlex(): ScriptedPlex {
  const next = new Map<number, Track[] | { error: PlexApiError }>();
  const fetchCalls: number[] = [];
  const client: PlexClient = {
    async fetchPlaylist(ratingKey): Promise<FetchPlaylistResult> {
      fetchCalls.push(ratingKey);
      const r = next.get(ratingKey);
      if (r === undefined) return { ratingKey, tracks: [], skipped: 0 };
      if ("error" in r) throw r.error;
      return { ratingKey, tracks: r, skipped: 0 };
    },
  };
  return { client, setNext: (id, r) => next.set(id, r), fetchCalls };
}

interface ManualSchedule {
  schedule: (cb: () => void, ms: number) => () => void;
  tick: () => Promise<void>;
}

function manualSchedule(): ManualSchedule {
  let cb: (() => void) | null = null;
  return {
    schedule: (callback) => {
      cb = callback;
      return () => {};
    },
    tick: async () => {
      if (!cb) throw new Error("schedule never invoked");
      cb();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

const TWO_STAGES: readonly Stage[] = [
  fakeStage("opening", 100),
  fakeStage("closing", 200),
];

describe("bootstrap — startup", () => {
  it("registers one controller per audio stage with fetched tracks", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1), makeTrack(2)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    assert.equal(result.registry.size, 2);
    assert.ok(result.registry.get("opening"));
    assert.ok(result.registry.get("closing"));
    assert.equal(created.length, 2);
    // Opening's supervisor was started with the right tracks.
    const opening = created.find((c) => c.stageId === "opening")!;
    assert.deepEqual(
      opening.config.tracks.map((t) => t.plexRatingKey),
      [1, 2],
    );
    // Per-stage hlsDir is composed correctly.
    assert.equal(
      opening.config.hlsDir,
      "/dev/shm/1008/radio-hls/opening",
    );
    assert.equal(opening.config.fallbackFile, "/curating.aac");
    assert.equal(opening.config.ffmpegBin, "ffmpeg");

    await result.shutdown();
  });

  it("starts a stage even when its initial Plex fetch fails (curating mode + retry on poll)", async () => {
    const plex = scriptedPlex();
    const boom: PlexApiError = Object.assign(new Error("boom") as PlexApiError, {
      name: "PlexApiError",
      detail: { kind: "auth" } as const,
      toJSON: () => ({}),
    });
    plex.setNext(100, { error: boom });
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();
    const logged: string[] = [];

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: (line) => logged.push(line),
    });

    assert.equal(result.registry.size, 2, "both stages registered");
    const opening = created.find((c) => c.stageId === "opening")!;
    assert.deepEqual(
      opening.config.tracks,
      [],
      "opening starts with empty track list → curating mode",
    );
    assert.ok(
      logged.some((l) => l.includes("opening initial Plex fetch FAILED")),
      "failure is logged",
    );

    await result.shutdown();
  });

  it("skips disabled stages (Bus) and stages with null plexPlaylistId", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [
        fakeStage("opening", 100),
        fakeStage("bus", null, true),
        fakeStage("ghost-stage", null), // not disabled but no playlist
      ],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    assert.equal(created.length, 1);
    assert.equal(created[0]!.stageId, "opening");

    await result.shutdown();
  });
});

describe("bootstrap — Plex polling triggers supervisor restart", () => {
  it("stops the old controller and registers a new one when tracks change", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1), makeTrack(2)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // Opening's tracks change — add track 3.
    plex.setNext(100, [makeTrack(1), makeTrack(2), makeTrack(3)]);
    plex.setNext(200, [makeTrack(10)]); // unchanged

    await sched.tick();

    // The original opening controller was stopped and replaced.
    const openings = created.filter((c) => c.stageId === "opening");
    assert.equal(openings.length, 2, "second supervisor was created");
    assert.equal(openings[0]!.stopped, true, "original was stopped");
    assert.deepEqual(
      openings[1]!.config.tracks.map((t) => t.plexRatingKey),
      [1, 2, 3],
    );

    // Closing was untouched.
    const closings = created.filter((c) => c.stageId === "closing");
    assert.equal(closings.length, 1);

    await result.shutdown();
  });

  it("does not restart a stage when only the order changed", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1), makeTrack(2)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    plex.setNext(100, [makeTrack(2), makeTrack(1)]); // reordered
    plex.setNext(200, [makeTrack(10)]);
    await sched.tick();

    const openings = created.filter((c) => c.stageId === "opening");
    assert.equal(openings.length, 1, "no restart on reorder");

    await result.shutdown();
  });
});

describe("bootstrap — shutdown", () => {
  it("shutdown() stops the poller and every supervisor", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    await result.shutdown();
    for (const c of created) {
      assert.equal(c.stopped, true, `${c.stageId} stopped`);
    }
  });

  it("shutdown() is idempotent", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    await Promise.all([
      result.shutdown(),
      result.shutdown(),
      result.shutdown(),
    ]);
    // No assertion needed — if it threw or hung, the test would fail.
  });
});

describe("bootstrap — HTTP integration", () => {
  it("the returned app's /api/stages/:id/now reads from the live registry", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    plex.setNext(200, [makeTrack(10)]);
    const { fakeStartStage } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    const res = await result.app.request("/api/stages/opening/now");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { stageId: string; status: string };
    assert.equal(body.stageId, "opening");
    assert.equal(body.status, "playing");

    await result.shutdown();
  });

  it("the returned app reports a known stage as 503 stage_not_running before bootstrap registers it", async () => {
    // Sanity check: an audio stage in the catalog but NOT in the
    // bootstrap audioStages list should look "not running" via the
    // endpoint. Verifies the endpoint reads the registry, not the
    // catalog, for liveness.
    const plex = scriptedPlex();
    const { fakeStartStage } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      // Only register opening — the request is for closing (a real
      // catalog stage with plexPlaylistId).
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    const res = await result.app.request("/api/stages/closing/now");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "stage_not_running");

    await result.shutdown();
  });
});
