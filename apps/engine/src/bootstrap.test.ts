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
  /** Track lists passed to setTracks() during this controller's life. */
  setTracksCalls: Array<readonly Track[]>;
  /** Resolves the `done` promise — simulates the run loop terminating
   *  unexpectedly so the bootstrap revival path can be exercised. */
  resolveDone: () => void;
}

function fakeStartStageFactory() {
  const created: FakeStageController[] = [];
  function fakeStartStage(config: StartStageConfig): StageController {
    let resolveDoneFn: (() => void) | null = null;
    const donePromise = new Promise<void>((resolve) => {
      resolveDoneFn = resolve;
    });
    const ctl: FakeStageController = {
      stageId: config.stageId,
      stopped: false,
      config,
      setTracksCalls: [],
      resolveDone: () => {
        if (resolveDoneFn) resolveDoneFn();
      },
      status: () => (ctl.stopped ? "stopped" : "playing"),
      currentTrack: () => null,
      snapshot: () => ({
        status: ctl.stopped ? "stopped" : "playing",
        track: null,
        trackStartedAt: null,
      }),
      setTracks: (tracks) => {
        ctl.setTracksCalls.push(tracks);
      },
      stop: async () => {
        ctl.stopped = true;
        if (resolveDoneFn) resolveDoneFn();
      },
      done: donePromise,
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

  it("fetches initial Plex playlists in PARALLEL — bootstrap doesn't serialize on slow Plex", async () => {
    // Regression (Codex [P2]): a serial bootstrap meant 10 audio
    // stages × 10s Plex timeout = up to 100s before HTTP bind +
    // signal handlers were installed. With Promise.all the worst
    // case collapses to the SLOWEST single fetch.
    let inflight = 0;
    let concurrentMax = 0;
    const slowClient: PlexClient = {
      fetchPlaylist: async (
        ratingKey,
      ): Promise<FetchPlaylistResult> => {
        inflight++;
        if (inflight > concurrentMax) concurrentMax = inflight;
        // Hold each fetch for a beat so the test can observe
        // concurrency.
        await new Promise((r) => setTimeout(r, 30));
        inflight--;
        return { ratingKey, tracks: [], skipped: 0 };
      },
    };
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();
    const start = Date.now();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: slowClient,
      startStageImpl: fakeStartStage,
      audioStages: TWO_STAGES,
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    const elapsed = Date.now() - start;
    assert.equal(created.length, 2);
    assert.ok(
      concurrentMax >= 2,
      `expected ≥2 concurrent fetches; saw ${concurrentMax}`,
    );
    // Two 30 ms fetches in parallel should finish well under 50 ms.
    // Two SERIAL fetches would take ≥60 ms.
    assert.ok(
      elapsed < 60,
      `bootstrap took ${elapsed}ms — fetches likely serialized`,
    );

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

describe("bootstrap — Plex polling queues track updates", () => {
  it("calls setTracks on the existing controller when tracks change (no restart)", async () => {
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

    // The original opening controller stays alive — setTracks was
    // called on it, NOT stop().
    const openings = created.filter((c) => c.stageId === "opening");
    assert.equal(openings.length, 1, "no second supervisor was created");
    assert.equal(openings[0]!.stopped, false, "original is still running");
    assert.equal(openings[0]!.setTracksCalls.length, 1);
    assert.deepEqual(
      openings[0]!.setTracksCalls[0]!.map((t) => t.plexRatingKey),
      [1, 2, 3],
    );

    // Closing was untouched (no setTracks call).
    const closings = created.filter((c) => c.stageId === "closing");
    assert.equal(closings.length, 1);
    assert.equal(closings[0]!.setTracksCalls.length, 0);

    await result.shutdown();
  });

  it("calls setTracks even when only the order changed (preserves Plex curator intent)", async () => {
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

    plex.setNext(100, [makeTrack(2), makeTrack(1)]); // reordered only
    plex.setNext(200, [makeTrack(10)]);
    await sched.tick();

    const openings = created.filter((c) => c.stageId === "opening");
    assert.equal(openings.length, 1);
    assert.equal(
      openings[0]!.setTracksCalls.length,
      1,
      "reorder still calls setTracks — supervisor swaps queue at next boundary",
    );
    assert.deepEqual(
      openings[0]!.setTracksCalls[0]!.map((t) => t.plexRatingKey),
      [2, 1],
    );

    await result.shutdown();
  });

  it("starts a fresh supervisor when the existing controller is already stopped (not just missing)", async () => {
    // Regression (Codex [P2]): a controller that reached "stopped"
    // (fallback preflight failure, crash cap, fatal error) stays in
    // the registry but its run loop has exited. setTracks() on that
    // corpse is a no-op. Without this fix, a broken stage would stay
    // dead until the engine restarted. With it, a later poll with
    // good tracks resurrects the stage.
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // Simulate the original controller having reached a terminal
    // state (crash cap with broken fallback).
    created[0]!.stopped = true;

    // Plex now has a fresh list.
    plex.setNext(100, [makeTrack(42)]);
    await sched.tick();

    // A SECOND supervisor was created, not a no-op setTracks on the
    // dead first one.
    assert.equal(created.length, 2);
    assert.equal(
      created[1]!.stageId,
      "opening",
      "fresh supervisor is registered for the same stage",
    );
    assert.deepEqual(
      created[1]!.config.tracks.map((t) => t.plexRatingKey),
      [42],
    );
    // And the stopped first one had no setTracks call (would have
    // been a no-op anyway).
    assert.equal(created[0]!.setTracksCalls.length, 0);

    await result.shutdown();
  });

  // The "no controller registered for the stage" branch in
  // bootstrap.onTracksChanged is now effectively unreachable in the
  // normal lifecycle: every audio stage gets a controller at startup,
  // and the liveness watcher (issue #12 item 2) immediately revives
  // any controller that terminates. The branch is kept defensively
  // for hypothetical future paths where a stage gets unregistered
  // externally; it doesn't need a regression test of its own.
});

describe("bootstrap — controller liveness watcher (issue #12)", () => {
  it("revives a supervisor whose run loop terminated unexpectedly while the engine is up", async () => {
    // Regression for issue #12 item 2: a supervisor that died
    // post-startup with no Plex change in sight stayed dead until
    // engine restart. The bootstrap-side liveness watcher restarts
    // it with the most recently known tracks.
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    assert.equal(created.length, 1);
    const first = created[0]!;

    // Simulate the run loop terminating unexpectedly (HLS dir mid-
    // run failure, fallback preflight invalidated, etc).
    first.stopped = true;
    first.resolveDone();

    // Wait for the watcher's microtask + the spawnAndWatch chain.
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(
      created.length,
      2,
      "bootstrap should have spawned a replacement controller",
    );
    const replacement = created[1]!;
    assert.equal(replacement.stageId, "opening");
    assert.deepEqual(
      replacement.config.tracks.map((t) => t.plexRatingKey),
      [1],
      "replacement uses the most recently known tracks (initial fetch)",
    );
    // Registry now points at the replacement, not the dead first one.
    assert.equal(result.registry.get("opening"), replacement);

    await result.shutdown();
  });

  it("does NOT revive supervisors when the engine is shutting down", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // Initiate shutdown — that flips the internal flag BEFORE
    // resolving each controller's `done` via stop(). The watcher
    // should see `shuttingDown` and skip revival.
    await result.shutdown();
    await new Promise((r) => setTimeout(r, 20));

    // Only the original controller exists — no zombie revive.
    assert.equal(
      created.length,
      1,
      "no revival should fire during/after shutdown",
    );
  });

  it("gives up reviving after MAX_CONSECUTIVE_FAST_DEATHS — no infinite respawn loop", async () => {
    // Regression (Codex [P1]): without a fast-death cap, a
    // permanently-broken stage (bad fallback file, deterministic
    // crash, etc.) would respawn forever, spamming logs and burning
    // cycles. The watcher rate-limits revivals: 3 fast deaths in a
    // row → give up; rely on the next Plex change or engine restart.
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // Kill controllers one at a time until the watcher stops
    // reviving. Counter caps at MAX_CONSECUTIVE_FAST_DEATHS=3, so:
    //   death 1 (original) → revive → controller [1] exists
    //   death 2 (rev #1)   → revive → controller [2] exists
    //   death 3 (rev #2)   → counter hits cap → NO new controller
    //
    // Loop until no new controller appears within a tick.
    for (let i = 0; i < 5; i++) {
      const before = created.length;
      const ctl = created[i];
      if (!ctl || ctl.stopped) break;
      ctl.stopped = true;
      ctl.resolveDone();
      await new Promise((r) => setTimeout(r, 20));
      if (created.length === before) break; // watcher gave up
    }

    // Total controllers = 1 original + 2 revivals = 3. The 3rd death
    // hits the cap and the watcher leaves the stage stopped.
    assert.equal(
      created.length,
      3,
      `expected exactly 3 (1 original + 2 revivals before cap), got ${created.length}`,
    );

    await result.shutdown();
  });

  it("a Plex-driven onTracksChanged restart resets the fast-death counter", async () => {
    // After the watcher gives up, a subsequent Plex change should
    // give the stage a fresh attempt.
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // Burn the revival budget — same loop structure as the cap test
    // above. 3 deaths total (1 original + 2 revivals).
    for (let i = 0; i < 5; i++) {
      const before = created.length;
      const ctl = created[i];
      if (!ctl || ctl.stopped) break;
      ctl.stopped = true;
      ctl.resolveDone();
      await new Promise((r) => setTimeout(r, 20));
      if (created.length === before) break;
    }
    assert.equal(created.length, 3); // gave up after the 3rd death

    // Plex now has a new track set. Poller fires onTracksChanged →
    // stopped controller → spawn fresh. Counter reset. Even if the
    // new one dies fast, it gets revivals again.
    plex.setNext(100, [makeTrack(2)]);
    await sched.tick();
    assert.equal(
      created.length,
      4,
      "Plex update should spawn a fresh controller",
    );
    // Fast-die the new one → should revive (counter was reset).
    created[3]!.stopped = true;
    created[3]!.resolveDone();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      created.length,
      5,
      "after Plex-driven restart, the watcher gets a fresh revival budget",
    );

    await result.shutdown();
  });

  it("uses the LATEST poller-known tracks when reviving (not the initial fetch)", async () => {
    const plex = scriptedPlex();
    plex.setNext(100, [makeTrack(1)]);
    const { fakeStartStage, created } = fakeStartStageFactory();
    const sched = manualSchedule();

    const result = await bootstrap({
      config: BASE_CONFIG,
      plexClient: plex.client,
      startStageImpl: fakeStartStage,
      audioStages: [fakeStage("opening", 100)],
      pollerSchedule: sched.schedule,
      log: () => {},
    });

    // First poller tick changes the playlist; setTracks is called
    // on the (still-alive) original. knownTracks is updated to [1, 7].
    plex.setNext(100, [makeTrack(1), makeTrack(7)]);
    await sched.tick();
    assert.equal(created[0]!.setTracksCalls.length, 1);

    // Now the original dies.
    created[0]!.stopped = true;
    created[0]!.resolveDone();
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(created.length, 2);
    assert.deepEqual(
      created[1]!.config.tracks.map((t) => t.plexRatingKey),
      [1, 7],
      "revival uses the latest known tracks, not the initial-fetch snapshot",
    );

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
