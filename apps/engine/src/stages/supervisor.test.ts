import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Track } from "@pavoia/shared";

import {
  startStage,
  type StageEvent,
  type RunTrackFn,
} from "./supervisor.ts";
import type { TrackExit, RunTrackInput } from "./runner.ts";

// --------------------------------------------------------------------
// Test helpers

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    plexRatingKey: 1,
    fallbackHash: "deadbeef00000000",
    title: "t",
    artist: "a",
    album: "b",
    albumYear: null,
    durationSec: 60,
    filePath: "/music/track.opus",
    coverUrl: null,
    ...overrides,
  };
}

interface ControlledRunner {
  run: RunTrackFn;
  calls: RunTrackInput[];
  /** Resolve the current in-flight run with the given exit. */
  complete: (exit: TrackExit) => void;
  /** Number of currently in-flight runs. */
  inflight: () => number;
  /** Wait until `calls.length >= n`, or reject on timeout. */
  waitForCall: (n: number, timeoutMs?: number) => Promise<void>;
}

interface Pending {
  resolve: (v: TrackExit) => void;
  settled: boolean;
}

function makeControlledRunner(): ControlledRunner {
  const calls: RunTrackInput[] = [];
  const pending: Pending[] = [];

  const run: RunTrackFn = (input) => {
    calls.push(input);
    return new Promise<TrackExit>((resolve) => {
      const entry: Pending = {
        settled: false,
        resolve: (v) => {
          if (entry.settled) return;
          entry.settled = true;
          resolve(v);
        },
      };
      pending.push(entry);
      // Mimic the real runTrack: an aborted signal auto-resolves to
      // { kind: "aborted" }. Without this, a supervisor stop() in the
      // middle of a test would hang the run loop.
      if (input.signal.aborted) {
        entry.resolve({ kind: "aborted" });
        return;
      }
      input.signal.addEventListener(
        "abort",
        () => entry.resolve({ kind: "aborted" }),
        { once: true },
      );
    });
  };

  const complete = (exit: TrackExit) => {
    const next = pending.find((p) => !p.settled);
    if (!next) throw new Error("no in-flight runTrack to complete");
    next.resolve(exit);
  };

  const waitForCall = async (n: number, timeoutMs = 2000) => {
    const start = Date.now();
    while (calls.length < n) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `timed out waiting for call ${n} (have ${calls.length})`,
        );
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const inflight = () => pending.filter((p) => !p.settled).length;
  return { run, calls, complete, inflight, waitForCall };
}

/** Immediate, abort-aware sleep. Tests run in milliseconds this way. */
const zeroSleep = (_ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    queueMicrotask(() => resolve());
  });

// --------------------------------------------------------------------
// Tests

describe("startStage — happy path", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("prepares + cleans hlsDir before any spawn", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    // Seed stale segments that must be removed.
    const stageDir = path.join(work, "opening");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(stageDir, { recursive: true });
    await writeFile(path.join(stageDir, "seg-00000.ts"), "x");
    await writeFile(path.join(stageDir, "index.m3u8"), "#EXTM3U\n");

    const ctl = startStage({
      stageId: "opening",
      tracks: [makeTrack()],
      hlsDir: stageDir,
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    // By the time ffmpeg is called, the dir must be clean.
    const contents = await readdir(stageDir);
    assert.deepEqual(contents, []);

    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    await ctl.stop();
  });

  it("runs tracks sequentially and wraps around", async () => {
    const runner = makeControlledRunner();
    const tracks = [
      makeTrack({ plexRatingKey: 10, filePath: "/m/1.opus" }),
      makeTrack({ plexRatingKey: 20, filePath: "/m/2.opus" }),
      makeTrack({ plexRatingKey: 30, filePath: "/m/3.opus" }),
    ];
    const events: StageEvent[] = [];

    const ctl = startStage({
      stageId: "seq",
      tracks,
      hlsDir: path.join(work, "seq"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(3);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(4);
    // Fourth call must be tracks[0] again (wraparound)
    assert.ok(runner.calls[3], "fourth call exists");
    assert.ok(
      runner.calls[3]!.argv.includes("/m/1.opus"),
      "wraparound back to tracks[0]",
    );

    await ctl.stop();

    const started = events.filter((e) => e.type === "track_started");
    assert.ok(started.length >= 3);
    assert.equal(
      (started[0] as Extract<StageEvent, { type: "track_started" }>).track
        .plexRatingKey,
      10,
    );
    assert.equal(
      (started[1] as Extract<StageEvent, { type: "track_started" }>).track
        .plexRatingKey,
      20,
    );
    assert.equal(
      (started[2] as Extract<StageEvent, { type: "track_started" }>).track
        .plexRatingKey,
      30,
    );
  });

  it("emits track_started + track_ended pairs with matching track", async () => {
    const runner = makeControlledRunner();
    const t = makeTrack({ plexRatingKey: 99 });
    const events: StageEvent[] = [];

    const ctl = startStage({
      stageId: "pair",
      tracks: [t],
      hlsDir: path.join(work, "pair"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    await ctl.stop();

    const started = events.find(
      (e): e is Extract<StageEvent, { type: "track_started" }> =>
        e.type === "track_started",
    );
    const ended = events.find(
      (e): e is Extract<StageEvent, { type: "track_ended" }> =>
        e.type === "track_ended",
    );
    assert.ok(started);
    assert.ok(ended);
    assert.equal(started.track.plexRatingKey, 99);
    assert.equal(ended.track.plexRatingKey, 99);
    assert.deepEqual(ended.exit, { kind: "ok" });
  });
});

describe("startStage — empty playlist / fallback", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("uses -stream_loop -1 on the fallback file when tracks is empty", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    const ctl = startStage({
      stageId: "empty",
      tracks: [],
      hlsDir: path.join(work, "empty"),
      fallbackFile: "/music/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    assert.ok(runner.calls[0], "first call exists");
    const argv = runner.calls[0]!.argv;
    const loopIdx = argv.indexOf("-stream_loop");
    const iIdx = argv.indexOf("-i");
    assert.ok(loopIdx >= 0 && argv[loopIdx + 1] === "-1");
    assert.ok(loopIdx < iIdx);
    assert.equal(argv[iIdx + 1], "/music/curating.aac");

    // stop() aborts the signal; the mock runner auto-resolves to aborted.
    await ctl.stop();

    const statuses = events
      .filter((e): e is Extract<StageEvent, { type: "status" }> => e.type === "status")
      .map((e) => e.status);
    assert.ok(statuses.includes("curating"));
  });
});

describe("startStage — crash handling", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("retries the same track after a crash, with backoff", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    let sleepCalls = 0;
    const trackedSleep = (ms: number, signal: AbortSignal) => {
      sleepCalls++;
      return zeroSleep(ms, signal);
    };

    const ctl = startStage({
      stageId: "crashy",
      tracks: [makeTrack({ plexRatingKey: 1 })],
      hlsDir: path.join(work, "crashy"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: trackedSleep,
      restartBackoffMs: 17,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(2);
    // Second spawn must be the SAME track (not advanced)
    assert.ok(runner.calls[1], "second call exists");
    assert.ok(runner.calls[1]!.argv.includes("/music/track.opus"));
    runner.complete({ kind: "ok" });
    await runner.waitForCall(3);
    await ctl.stop();

    assert.ok(sleepCalls >= 1, "sleep must be called between crashes");

    const crashes = events.filter(
      (e): e is Extract<StageEvent, { type: "crash" }> => e.type === "crash",
    );
    assert.equal(crashes.length, 1);
    assert.equal(crashes[0]?.consecutive, 1);
  });

  it("skips a track after maxConsecutiveCrashes and advances", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    const tracks = [
      makeTrack({ plexRatingKey: 1, filePath: "/m/corrupt.opus" }),
      makeTrack({ plexRatingKey: 2, filePath: "/m/fine.opus" }),
    ];

    const ctl = startStage({
      stageId: "skippy",
      tracks,
      hlsDir: path.join(work, "skippy"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 3,
    });

    // Crash 3 times on the first track
    for (let n = 1; n <= 3; n++) {
      await runner.waitForCall(n);
      runner.complete({ kind: "crashed", code: 1, signal: null });
    }

    // Next spawn must be the SECOND track (advanced past the corrupt one)
    await runner.waitForCall(4);
    assert.ok(runner.calls[3], "fourth call exists");
    assert.ok(runner.calls[3]!.argv.includes("/m/fine.opus"));

    await ctl.stop();

    const skipped = events.find(
      (e): e is Extract<StageEvent, { type: "skipped_after_repeated_crashes" }> =>
        e.type === "skipped_after_repeated_crashes",
    );
    assert.ok(skipped);
    assert.equal(skipped.track.plexRatingKey, 1);
  });

  it("resets the consecutive-crash counter on a successful run", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    const ctl = startStage({
      stageId: "reset",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "reset"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 3,
    });

    // Crash twice
    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(2);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    // Succeed on the third
    await runner.waitForCall(3);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(4);
    // Fourth is the track again (single-track loop wrap). Crash again twice more — must NOT be skipped.
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(5);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(6);
    // Still not skipped (would need 3 consecutive after the success)
    const skipped = events.find(
      (e) => e.type === "skipped_after_repeated_crashes",
    );
    assert.equal(skipped, undefined);
    await ctl.stop();
  });
});

describe("startStage — graceful stop", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("stop() aborts the run loop and resolves once done", async () => {
    const runner = makeControlledRunner();
    const ctl = startStage({
      stageId: "stop",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "stop"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    await ctl.stop();

    assert.equal(ctl.status(), "stopped");
    assert.equal(ctl.currentTrack(), null);
  });

  it("stop() is idempotent — multiple calls resolve to the same state", async () => {
    const runner = makeControlledRunner();
    const ctl = startStage({
      stageId: "idem",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "idem"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    const a = ctl.stop();
    const b = ctl.stop();
    const c = ctl.stop();
    await Promise.all([a, b, c]);
    assert.equal(ctl.status(), "stopped");
  });

  it("aborting during backoff exits the loop without another spawn", async () => {
    const runner = makeControlledRunner();
    let resolveSleep: (() => void) | null = null;
    let rejectSleep: ((err: Error) => void) | null = null;

    const heldSleep = (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        resolveSleep = resolve;
        rejectSleep = reject;
        signal.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });

    const ctl = startStage({
      stageId: "bounce",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "bounce"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      sleep: heldSleep,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    // Wait for sleep to be engaged
    const start = Date.now();
    while (!rejectSleep && Date.now() - start < 1000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(rejectSleep, "supervisor must have entered backoff");

    await ctl.stop();
    assert.equal(ctl.status(), "stopped");
    // No additional spawn happened during or after the interrupted sleep
    assert.equal(runner.calls.length, 1);
    // Unused to silence the linter about resolveSleep
    void resolveSleep;
  });

  it("reports status transitions: starting → playing → stopping → stopped", async () => {
    const runner = makeControlledRunner();
    const statuses: string[] = [];
    const ctl = startStage({
      stageId: "status",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "status"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => {
        if (e.type === "status") statuses.push(e.status);
      },
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    await ctl.stop();

    assert.ok(statuses.includes("playing"), `statuses: ${statuses.join(",")}`);
    assert.ok(statuses.includes("stopping"));
    assert.equal(statuses.at(-1), "stopped");
  });
});

describe("startStage — observer safety", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("a throwing onEvent does not take the supervisor down", async () => {
    const runner = makeControlledRunner();
    const ctl = startStage({
      stageId: "boom",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "boom"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: () => {
        throw new Error("subscriber down");
      },
      runTrackImpl: runner.run,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    await ctl.stop();
    assert.equal(ctl.status(), "stopped");
  });
});
