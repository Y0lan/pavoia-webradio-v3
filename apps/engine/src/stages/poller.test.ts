import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Track } from "@pavoia/shared";

import { startPlexPoller, type StageBinding } from "./poller.ts";
import type {
  FetchPlaylistResult,
  PlexApiError,
  PlexClient,
} from "../plex/client.ts";

function makeTrack(plexRatingKey: number): Track {
  return {
    plexRatingKey,
    fallbackHash: `hash-${plexRatingKey}`,
    title: `t${plexRatingKey}`,
    artist: "a",
    album: "b",
    albumYear: null,
    durationSec: 60,
    filePath: `/m/${plexRatingKey}.opus`,
    coverUrl: null,
  };
}

interface ScriptedPlex {
  client: PlexClient;
  /** Set the next response for a given playlist id. */
  setNext(playlistId: number, tracks: Track[] | { error: PlexApiError }): void;
  callCounts: Map<number, number>;
}

function scriptedPlex(): ScriptedPlex {
  const next = new Map<number, Track[] | { error: PlexApiError }>();
  const callCounts = new Map<number, number>();
  const client: PlexClient = {
    fetchPlaylist: async (
      ratingKey,
    ): Promise<FetchPlaylistResult> => {
      callCounts.set(ratingKey, (callCounts.get(ratingKey) ?? 0) + 1);
      const r = next.get(ratingKey);
      if (r === undefined) {
        return { ratingKey, tracks: [], skipped: 0 };
      }
      if ("error" in r) throw r.error;
      return { ratingKey, tracks: r, skipped: 0 };
    },
  };
  return {
    client,
    setNext: (id, v) => next.set(id, v),
    callCounts,
  };
}

interface ManualSchedule {
  schedule: (cb: () => void, ms: number) => () => void;
  /** Synchronously fire one poll tick. */
  tick: () => Promise<void>;
  cancelled: () => boolean;
  intervalMs: () => number | undefined;
}

function manualSchedule(): ManualSchedule {
  let cb: (() => void) | null = null;
  let cancelled = false;
  let lastInterval: number | undefined;
  return {
    schedule: (callback, ms) => {
      cb = callback;
      lastInterval = ms;
      return () => {
        cancelled = true;
      };
    },
    tick: async () => {
      if (!cb) throw new Error("schedule was never called");
      cb();
      // Allow the poller's internal Promise.all to resolve.
      await new Promise((r) => setImmediate(r));
      // And one more turn for onTracksChanged callbacks.
      await new Promise((r) => setImmediate(r));
    },
    cancelled: () => cancelled,
    intervalMs: () => lastInterval,
  };
}

const BINDINGS: readonly StageBinding[] = [
  { stageId: "opening", plexPlaylistId: 100 },
  { stageId: "closing", plexPlaylistId: 200 },
];

describe("startPlexPoller", () => {
  it("does NOT fire onTracksChanged on the first tick when initialTracks matches", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    plex.setNext(100, [makeTrack(1), makeTrack(2)]);
    plex.setNext(200, [makeTrack(3)]);

    const seen: Array<[string, number[]]> = [];
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: BINDINGS,
      intervalMs: 1000,
      initialTracks: new Map([
        ["opening", [makeTrack(1), makeTrack(2)]],
        ["closing", [makeTrack(3)]],
      ]),
      onTracksChanged: (id, tracks) => {
        seen.push([id, tracks.map((t) => t.plexRatingKey)]);
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    assert.deepEqual(seen, [], "no callback when sets match initial");
    await ctl.stop();
  });

  it("fires onTracksChanged when a stage's track set changes (added)", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    plex.setNext(100, [makeTrack(1), makeTrack(2), makeTrack(3)]); // added 3
    plex.setNext(200, [makeTrack(10)]); // unchanged

    const seen: Array<[string, number[]]> = [];
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: BINDINGS,
      intervalMs: 1000,
      initialTracks: new Map([
        ["opening", [makeTrack(1), makeTrack(2)]],
        ["closing", [makeTrack(10)]],
      ]),
      onTracksChanged: (id, tracks) => {
        seen.push([id, tracks.map((t) => t.plexRatingKey).sort()]);
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], "opening");
    assert.deepEqual(seen[0]![1], [1, 2, 3]);
    await ctl.stop();
  });

  it("DOES fire onTracksChanged when only the order changed (preserves curator intent)", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    plex.setNext(100, [makeTrack(2), makeTrack(1)]); // reordered
    plex.setNext(200, [makeTrack(10)]);

    const seen: Array<[string, number[]]> = [];
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: BINDINGS,
      intervalMs: 1000,
      initialTracks: new Map([
        ["opening", [makeTrack(1), makeTrack(2)]],
        ["closing", [makeTrack(10)]],
      ]),
      onTracksChanged: (id, tracks) => {
        seen.push([id, tracks.map((t) => t.plexRatingKey)]);
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    // The supervisor's setTracks queues the new ORDER for the next
    // track boundary — no playback interruption. Without this, the
    // curator's reorder would be silently dropped until a separate
    // add/remove event came along.
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], "opening");
    assert.deepEqual(seen[0]![1], [2, 1]);
    await ctl.stop();
  });

  it("retries the diff on the next tick when onTracksChanged threw", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    // Both ticks see the same diff (Plex hasn't changed since the
    // miss). The poller should still call onTracksChanged on tick 2
    // because lastKnown wasn't committed when tick 1 threw.
    plex.setNext(100, [makeTrack(1), makeTrack(2), makeTrack(3)]);

    let callCount = 0;
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: [{ stageId: "opening", plexPlaylistId: 100 }],
      intervalMs: 1000,
      initialTracks: new Map([["opening", [makeTrack(1), makeTrack(2)]]]),
      onTracksChanged: () => {
        callCount++;
        if (callCount === 1) throw new Error("transient supervisor failure");
      },
      schedule: sched.schedule,
    });

    await sched.tick(); // tick 1: throws, lastKnown NOT advanced
    plex.setNext(100, [makeTrack(1), makeTrack(2), makeTrack(3)]);
    await sched.tick(); // tick 2: same diff, retried, succeeds
    assert.equal(
      callCount,
      2,
      "must retry the failed update — leaving lastKnown stale would strand the stage",
    );
    await ctl.stop();
  });

  it("forwards Plex errors to onError but keeps polling other stages", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    const boomErr: PlexApiError = Object.assign(
      new Error("boom") as PlexApiError,
      {
        name: "PlexApiError",
        detail: { kind: "auth" } as const,
        toJSON: () => ({}),
      },
    );
    plex.setNext(100, { error: boomErr });
    plex.setNext(200, [makeTrack(10), makeTrack(11)]); // changed

    const errors: Array<[string, PlexApiError]> = [];
    const seen: string[] = [];
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: BINDINGS,
      intervalMs: 1000,
      initialTracks: new Map([
        ["opening", [makeTrack(1)]],
        ["closing", [makeTrack(10)]],
      ]),
      onTracksChanged: (id) => {
        seen.push(id);
      },
      onError: (id, err) => {
        errors.push([id, err]);
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    assert.equal(errors.length, 1);
    assert.equal(errors[0]![0], "opening");
    assert.deepEqual(seen, ["closing"], "other stage still polled");
    await ctl.stop();
  });

  it("a throwing onError does not crash the poller", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    const boomErr: PlexApiError = Object.assign(
      new Error("boom") as PlexApiError,
      {
        name: "PlexApiError",
        detail: { kind: "auth" } as const,
        toJSON: () => ({}),
      },
    );
    plex.setNext(100, { error: boomErr });
    plex.setNext(200, [makeTrack(10)]);

    let onTracksCallCount = 0;
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: BINDINGS,
      intervalMs: 1000,
      initialTracks: new Map([
        ["opening", [makeTrack(1)]],
        ["closing", [makeTrack(10)]],
      ]),
      onTracksChanged: () => {
        onTracksCallCount++;
      },
      onError: () => {
        throw new Error("logger bug");
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    // closing still considered (no diff → no callback). The point is
    // the poller didn't throw.
    assert.equal(onTracksCallCount, 0);
    await ctl.stop();
  });

  it("a throwing onTracksChanged does not crash the poller", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    plex.setNext(100, [makeTrack(99)]); // changed

    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: [{ stageId: "opening", plexPlaylistId: 100 }],
      intervalMs: 1000,
      initialTracks: new Map([["opening", [makeTrack(1)]]]),
      onTracksChanged: () => {
        throw new Error("supervisor restart failed");
      },
      schedule: sched.schedule,
    });

    await sched.tick();
    // No assertion needed — if it crashed, the test runner would surface it.
    await ctl.stop();
  });

  it("skips a scheduled tick when a previous tick is still in flight (no overlap)", async () => {
    // Regression (Codex [P2]): setInterval doesn't wait for async
    // callbacks. If a Plex fetch takes longer than intervalMs, a
    // second tick would start and overlap the first — the slower
    // response could commit after the faster one and revert a stage
    // to a stale track list. Fix: the scheduler callback returns
    // immediately when tickInFlight is set.
    const plex = scriptedPlex();
    const sched = manualSchedule();
    let inflight = 0;
    let concurrentMax = 0;
    const slowClient: PlexClient = {
      fetchPlaylist: async (
        ratingKey,
      ): Promise<FetchPlaylistResult> => {
        inflight++;
        if (inflight > concurrentMax) concurrentMax = inflight;
        await new Promise((r) => setTimeout(r, 40));
        inflight--;
        void plex; // eslint satisfier
        return { ratingKey, tracks: [], skipped: 0 };
      },
    };

    const ctl = startPlexPoller({
      plexClient: slowClient,
      bindings: [{ stageId: "opening", plexPlaylistId: 100 }],
      intervalMs: 1, // absurdly fast schedule to expose overlap
      initialTracks: new Map(),
      onTracksChanged: () => {},
      schedule: sched.schedule,
    });

    // Fire the schedule callback twice in quick succession. Without
    // the guard, the second would start a parallel fetch.
    sched.tick(); // returns once setImmediate drains, but the fetch
                  // is still pending (40 ms mock delay)
    sched.tick(); // should be a no-op
    await new Promise((r) => setTimeout(r, 80)); // let the slow fetch finish

    assert.equal(
      concurrentMax,
      1,
      `expected ≤1 concurrent tick; saw ${concurrentMax}`,
    );
    await ctl.stop();
  });

  it("stop() cancels the schedule and waits for an in-flight tick", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    plex.setNext(100, [makeTrack(1)]);

    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: [{ stageId: "opening", plexPlaylistId: 100 }],
      intervalMs: 1000,
      initialTracks: new Map(),
      onTracksChanged: async () => {
        await new Promise((r) => setTimeout(r, 20));
      },
      schedule: sched.schedule,
    });

    void sched.tick(); // fire and forget
    await ctl.stop();
    assert.equal(sched.cancelled(), true);
  });

  it("uses the configured intervalMs for the schedule", async () => {
    const plex = scriptedPlex();
    const sched = manualSchedule();
    const ctl = startPlexPoller({
      plexClient: plex.client,
      bindings: [],
      intervalMs: 12345,
      initialTracks: new Map(),
      onTracksChanged: () => {},
      schedule: sched.schedule,
    });
    assert.equal(sched.intervalMs(), 12345);
    await ctl.stop();
  });
});
