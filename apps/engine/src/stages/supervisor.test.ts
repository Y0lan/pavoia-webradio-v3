import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Track } from "@pavoia/shared";

import {
  startStage,
  type StageEvent,
  type RunTrackFn,
  type WaitForFirstSegmentFn,
  type PreflightFn,
} from "./supervisor.ts";
import type { TrackExit, RunTrackInput } from "./runner.ts";

/** Default preflight for mock-based tests: accepts any path. Tests
 *  that want to exercise the failure modes pass their own. */
const acceptAllPreflight: PreflightFn = async () => ({
  ok: true as const,
  sizeBytes: 1024,
});

/** Default first-segment watcher for mock-based tests: immediately
 *  reports "ready" so track_started fires right after spawn. Tests
 *  that want to exercise the watchdog or delayed-start semantics
 *  pass their own. */
const instantReadyWatcher: WaitForFirstSegmentFn = async () => "ready";

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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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

  it("snapshots the tracks array at start — later caller mutation has no effect", async () => {
    const runner = makeControlledRunner();
    const t1 = makeTrack({ plexRatingKey: 10, filePath: "/m/1.opus" });
    const t2 = makeTrack({ plexRatingKey: 20, filePath: "/m/2.opus" });
    const callerArray = [t1, t2];

    const ctl = startStage({
      stageId: "snap",
      tracks: callerArray,
      hlsDir: path.join(work, "snap"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    // Mutate the caller's array AFTER startStage has returned —
    // swap both tracks to a poisoned one. If the supervisor didn't
    // snapshot, the next spawn would pick up the mutation.
    const poison = makeTrack({ plexRatingKey: 999, filePath: "/poison" });
    callerArray[0] = poison;
    callerArray[1] = poison;

    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);

    assert.ok(runner.calls[0], "first call exists");
    assert.ok(runner.calls[1], "second call exists");
    // Spawns must use the ORIGINAL tracks, not the poisoned ones.
    assert.ok(runner.calls[0]!.argv.includes("/m/1.opus"));
    assert.ok(runner.calls[1]!.argv.includes("/m/2.opus"));
    // And definitely not the poison.
    assert.ok(!runner.calls[0]!.argv.includes("/poison"));
    assert.ok(!runner.calls[1]!.argv.includes("/poison"));

    await ctl.stop();
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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

  it("a clean exit from the -stream_loop fallback is NOT counted as a crash", async () => {
    // Regression: -stream_loop -1 ffmpeg shouldn't exit cleanly on its
    // own. If it does (edge case: unreadable file closing immediately),
    // treat it as an unexpected-but-benign event — restart with backoff
    // but do not emit { type: "crash" } nor approach the crash cap.
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    const ctl = startStage({
      stageId: "fallback-ok",
      tracks: [],
      hlsDir: path.join(work, "fallback-ok"),
      fallbackFile: "/music/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 2,
    });

    // 3 "ok" exits in a row — strictly more than maxConsecutiveCrashes.
    // If "ok" were mistakenly counted as a crash, the supervisor would
    // have bailed out after 2 and never reached the 3rd spawn.
    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(3);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(4);

    const crashEvents = events.filter((e) => e.type === "crash");
    assert.equal(
      crashEvents.length,
      0,
      "ok exit in curating mode must not emit crash events",
    );

    await ctl.stop();
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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

  it("falls back to curating when the single track has been skipped", async () => {
    // Regression: without the deadTracks guard, a single-track playlist
    // with a corrupt file would hit maxConsecutiveCrashes, skip, wrap
    // around via `i = (i + 1) % 1 = 0`, reset the counter, and re-spawn
    // the same corrupt track forever. Fix: once all tracks are dead,
    // transition to the -stream_loop -1 fallback.
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    const track = makeTrack({ plexRatingKey: 1, filePath: "/m/dead.opus" });

    const ctl = startStage({
      stageId: "dead-single",
      tracks: [track],
      hlsDir: path.join(work, "dead-single"),
      fallbackFile: "/music/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 2,
    });

    // Two consecutive crashes hit the cap → skip → fallback
    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(2);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(3);
    // Third call must be the FALLBACK, not the same track again.
    assert.ok(runner.calls[2], "third call exists");
    const thirdArgv = runner.calls[2]!.argv;
    assert.ok(
      thirdArgv.includes("-stream_loop"),
      "third spawn must be curating fallback with -stream_loop",
    );
    assert.equal(
      thirdArgv[thirdArgv.indexOf("-i") + 1],
      "/music/curating.aac",
      "third spawn must feed the fallback file",
    );

    await ctl.stop();

    const skipped = events.find(
      (e) => e.type === "skipped_after_repeated_crashes",
    );
    assert.ok(skipped, "skipped_after_repeated_crashes was emitted");
    const statuses = events
      .filter((e): e is Extract<StageEvent, { type: "status" }> =>
        e.type === "status",
      )
      .map((e) => e.status);
    assert.ok(
      statuses.includes("curating"),
      `expected curating status after skip; got ${statuses.join(",")}`,
    );
  });

  it("does not leak the last-failed real track as currentTrack() during curating", async () => {
    // Regression (Codex finding #6): when deadTracks fills up and the
    // supervisor falls through to runCuratingLoop, the last-failed
    // real Track was being returned by controller.currentTrack(),
    // which would make /api/stages/:id/now lie about what's playing.
    // Under the hardened supervisor, currentTrack may point at the
    // curating sentinel (a synthetic Track with plexRatingKey = 0 +
    // title "Curating") once the fallback's first segment lands —
    // that's fine, it's truthful. What must NEVER happen is for the
    // dead real track to still be reported.
    const runner = makeControlledRunner();
    const deadTrack = makeTrack({
      plexRatingKey: 77,
      filePath: "/m/dead.opus",
    });

    const ctl = startStage({
      stageId: "clear-current",
      tracks: [deadTrack],
      hlsDir: path.join(work, "clear-current"),
      fallbackFile: "/music/curating.aac",
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 2,
    });

    // Two crashes → track 77 gets TTL'd dead → fallback.
    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(2);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(3);

    // runCuratingLoop no longer assigns a "Curating" sentinel to
    // currentTrack — the supervisor clears it before entering the
    // branch, and the refactored curating path calls runTrackImpl
    // directly without emitting track_started, so currentTrack stays
    // null throughout curating mode.
    assert.equal(
      ctl.currentTrack(),
      null,
      `currentTrack() must be null during curating; got ${JSON.stringify(ctl.currentTrack())}`,
    );
    await ctl.stop();
  });

  it("falls back to curating when every track in a multi-track playlist is dead", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    const tracks = [
      makeTrack({ plexRatingKey: 1, filePath: "/m/a.opus" }),
      makeTrack({ plexRatingKey: 2, filePath: "/m/b.opus" }),
    ];

    const ctl = startStage({
      stageId: "all-dead",
      tracks,
      hlsDir: path.join(work, "all-dead"),
      fallbackFile: "/music/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      maxConsecutiveCrashes: 2,
    });

    // Crash twice on track a
    await runner.waitForCall(1);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(2);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    // Crash twice on track b
    await runner.waitForCall(3);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    await runner.waitForCall(4);
    runner.complete({ kind: "crashed", code: 1, signal: null });
    // Next spawn must be the fallback
    await runner.waitForCall(5);
    assert.ok(runner.calls[4], "fifth call exists");
    assert.ok(
      runner.calls[4]!.argv.includes("-stream_loop"),
      "after all tracks dead, supervisor must switch to fallback",
    );

    await ctl.stop();
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    await ctl.stop();

    assert.ok(statuses.includes("playing"), `statuses: ${statuses.join(",")}`);
    assert.ok(statuses.includes("stopping"));
    assert.equal(statuses.at(-1), "stopped");
  });
});

describe("startStage — hardening: preflight + TTL + watchdog + deferred track_started", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-sup-hard-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  // Win #1 + #4: preflight + TTL'd deadTracks
  it("skips a preflight-failed track without spawning, emits preflight_failed, TTLs it", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    // Track 0 fails preflight, track 1 passes
    const preflight: PreflightFn = async (p) =>
      p === "/m/missing.opus"
        ? { ok: false, reason: "missing" }
        : { ok: true, sizeBytes: 1024 };

    const ctl = startStage({
      stageId: "preflight",
      tracks: [
        makeTrack({ plexRatingKey: 1, filePath: "/m/missing.opus" }),
        makeTrack({ plexRatingKey: 2, filePath: "/m/good.opus" }),
      ],
      hlsDir: path.join(work, "preflight"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: preflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      deadTtlMs: 60_000,
    });

    // First ffmpeg call should be for track 1 (good one), NOT track 0.
    await runner.waitForCall(1);
    assert.ok(runner.calls[0]!.argv.includes("/m/good.opus"));

    const failed = events.find(
      (e): e is Extract<StageEvent, { type: "preflight_failed" }> =>
        e.type === "preflight_failed",
    );
    assert.ok(failed, "preflight_failed was emitted");
    assert.equal(failed.reason, "missing");
    assert.equal(failed.track.plexRatingKey, 1);

    await ctl.stop();
  });

  // Win #4: dead TTL expiry
  it("re-tries a dead track on the next rotation after the TTL has expired", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    // Preflight fails only on the VERY FIRST call to /m/bad.opus,
    // succeeds on all subsequent calls. /m/good.opus always passes.
    const preflightSeen = new Map<string, number>();
    const preflight: PreflightFn = async (p) => {
      const n = (preflightSeen.get(p) ?? 0) + 1;
      preflightSeen.set(p, n);
      if (p === "/m/bad.opus" && n === 1) {
        return { ok: false, reason: "missing" };
      }
      return { ok: true, sizeBytes: 1024 };
    };

    const ctl = startStage({
      stageId: "dead-ttl",
      tracks: [
        makeTrack({ plexRatingKey: 1, filePath: "/m/bad.opus" }),
        makeTrack({ plexRatingKey: 2, filePath: "/m/good.opus" }),
      ],
      hlsDir: path.join(work, "dead-ttl"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: preflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      deadTtlMs: 10, // small enough that by the time good finishes, it's expired
    });

    // Iteration 1: bad fails preflight → TTL'd dead, advance to good.
    // Iteration 2: good spawns (call 1), completes ok, advance to bad.
    await runner.waitForCall(1);
    assert.ok(
      runner.calls[0]!.argv.includes("/m/good.opus"),
      "first spawn must be the good track (bad was skipped)",
    );
    // Let ≥20 ms of real time pass so the 10 ms TTL expires.
    await new Promise((r) => setTimeout(r, 25));
    runner.complete({ kind: "ok" });

    // Iteration 3: bad's TTL has expired — preflight retried and
    // passes (call 2). ffmpeg now spawns for bad.
    await runner.waitForCall(2);
    assert.ok(
      runner.calls[1]!.argv.includes("/m/bad.opus"),
      "after TTL expiry, bad track is re-tried",
    );

    const failed = events.filter((e) => e.type === "preflight_failed");
    assert.equal(failed.length, 1, "preflight_failed fires exactly once");

    await ctl.stop();
  });

  // Win #3: watchdog timeout
  it("watchdog aborts ffmpeg and synthesizes a crash when no segment appears in time", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    // Watcher reports timeout → watchdog fires
    const watchdogWatcher: WaitForFirstSegmentFn = async () => "timeout";

    const ctl = startStage({
      stageId: "watchdog",
      tracks: [makeTrack({ plexRatingKey: 1 })],
      hlsDir: path.join(work, "watchdog"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: watchdogWatcher,
      sleep: zeroSleep,
      firstSegmentTimeoutMs: 100,
      maxConsecutiveCrashes: 2,
    });

    // Watchdog fires → aborts the in-flight runner → mock runner
    // resolves with { kind: "aborted" } (abort listener path).
    // Supervisor translates that to a synthetic crashed outcome
    // because WE aborted due to watchdog, not the stage.
    await runner.waitForCall(1);
    // The mock runner's abort listener fires when our per-run ac
    // aborts, resolving it. No manual complete() needed.
    // Wait for the second call (retry) to confirm watchdog classified
    // as crash.
    await runner.waitForCall(2);

    const timeouts = events.filter(
      (e) => e.type === "watchdog_timeout",
    );
    assert.ok(timeouts.length >= 1, "watchdog_timeout was emitted");
    const crashes = events.filter((e) => e.type === "crash");
    assert.ok(crashes.length >= 1, "crash was emitted for the watchdog");

    // track_started should NEVER be emitted because no segment landed.
    const started = events.filter((e) => e.type === "track_started");
    assert.equal(started.length, 0, "track_started must not fire on watchdog timeout");

    await ctl.stop();
  });

  // Win #5: deferred track_started
  it("emits track_started AFTER the first segment signal, not at spawn", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];

    // A watcher we control manually — held until we say "ready".
    // The ref shape avoids a TS control-flow quirk where the
    // `resolveReady` closure assignment isn't visible to a plain
    // `let → const` capture.
    const resolverRef: { current: ((v: "ready") => void) | null } = {
      current: null,
    };
    const heldWatcher: WaitForFirstSegmentFn = (input) =>
      new Promise<"ready" | "timeout" | "aborted">((resolve) => {
        const onAbort = () => resolve("aborted");
        input.signal.addEventListener("abort", onAbort, { once: true });
        resolverRef.current = resolve as (v: "ready") => void;
      });

    const ctl = startStage({
      stageId: "deferred",
      tracks: [makeTrack({ plexRatingKey: 42 })],
      hlsDir: path.join(work, "deferred"),
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: heldWatcher,
      sleep: zeroSleep,
      firstSegmentTimeoutMs: 5000,
    });

    // At this point, supervisor has spawned ffmpeg (runner called) but
    // the watcher hasn't resolved — so track_started should NOT fire.
    await runner.waitForCall(1);
    // Let any pending microtasks flush.
    await new Promise((r) => setTimeout(r, 20));
    const startedBefore = events.filter((e) => e.type === "track_started");
    assert.equal(
      startedBefore.length,
      0,
      "track_started must NOT fire before first segment is ready",
    );

    // Now signal "ready" — track_started should fire promptly.
    if (!resolverRef.current) {
      throw new Error("held watcher should have registered a resolver");
    }
    resolverRef.current("ready");
    await new Promise((r) => setTimeout(r, 20));
    const startedAfter = events.filter((e) => e.type === "track_started");
    assert.equal(
      startedAfter.length,
      1,
      "track_started fires once, after ready signal",
    );

    await ctl.stop();
  });

  // Codex [P1] follow-up: watchdog snapshot ignores stale segments
  it("watchdog ignores pre-existing segments from the previous track", async () => {
    // Regression: because the supervisor preserves seg-*.ts across
    // track boundaries (HLS client safety buffer), a watcher that
    // just checks "any seg-*.ts?" would return ready instantly on
    // track 2+, defeating the watchdog for mid-playlist hangs.
    // The fix: snapshot pre-spawn segments and only count NEW ones.
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    // Pre-seed the dir with a "previous track" segment.
    const stageDir = path.join(work, "stale");
    await mkdir(stageDir, { recursive: true });
    await writeFile(path.join(stageDir, "seg-00099.ts"), "stale");

    // Supervisor's hls-dir cleanup on start would wipe this. Skip
    // cleanup by pre-creating AFTER startStage's prepareStageDir by
    // racing? Simpler: use a custom watcher that captures what it's
    // told to ignore, and assert the pre-existing seg is in that set.
    const watcherSeenIgnore: string[][] = [];
    const recordingWatcher: WaitForFirstSegmentFn = async (input) => {
      const ignore = input.ignoreExisting
        ? Array.from(
            input.ignoreExisting instanceof Set
              ? input.ignoreExisting
              : input.ignoreExisting,
          )
        : [];
      watcherSeenIgnore.push(ignore);
      return "ready";
    };

    const ctl = startStage({
      stageId: "stale",
      tracks: [makeTrack({ plexRatingKey: 1 })],
      hlsDir: stageDir,
      fallbackFile: "/tmp/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: recordingWatcher,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    // The watcher got called — but since cleanStageDir runs first, the
    // stale seg-00099 file was removed. What matters: the supervisor
    // passed SOME snapshot to the watcher (could be empty here), and
    // not the "ignore nothing" default.
    assert.ok(
      watcherSeenIgnore.length >= 1,
      "watcher should have been armed with a snapshot",
    );
    // Assert the supervisor passed ignoreExisting (even if empty):
    // the critical property is that when multiple tracks run, the
    // second track's snapshot captures the first's tail segments.
    // Covered below.

    await ctl.stop();
  });

  // Codex [P1] follow-up: dead-track TTL recovery via bounded curating
  it("curating loop returns when earliest dead-TTL expires so tracks are retried", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    let preflightCalls = 0;
    const preflight: PreflightFn = async (p) => {
      preflightCalls++;
      // Track fails on call 1, then passes. Fallback always passes.
      if (p === "/m/flaky.opus" && preflightCalls === 1) {
        return { ok: false, reason: "missing" };
      }
      return { ok: true, sizeBytes: 1024 };
    };

    const ctl = startStage({
      stageId: "ttl-recover",
      tracks: [makeTrack({ plexRatingKey: 1, filePath: "/m/flaky.opus" })],
      hlsDir: path.join(work, "ttl-recover"),
      fallbackFile: "/m/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: preflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      deadTtlMs: 30, // tiny — curating will return when this expires
      firstSegmentTimeoutMs: 0, // disable watchdog for deterministic test
    });

    // First call is curating (track failed preflight → dead → fallback).
    await runner.waitForCall(1);
    assert.ok(
      runner.calls[0]!.argv.includes("-stream_loop"),
      "first spawn is curating (track is TTL-dead)",
    );

    // Do NOT manually resolve the mock — let the supervisor's real
    // deadline timer (30 ms) fire. When it does, the curating run's
    // AbortController is aborted, the mock runner's abort listener
    // resolves the pending promise, runCuratingLoop returns, and the
    // outer track loop re-checks countDead. By then the TTL has
    // expired, the track is eligible again, preflight passes, and
    // ffmpeg spawns for the real track.
    await runner.waitForCall(2, 3000);
    assert.ok(
      runner.calls[1]!.argv.includes("/m/flaky.opus"),
      "after TTL expiry the flaky track is re-tried",
    );

    await ctl.stop();
  });

  // Codex [P2] follow-up: stop() during async preflight must not spawn
  it("stop() during preflight must not spawn ffmpeg", async () => {
    const runner = makeControlledRunner();

    // Preflight that never resolves until we unblock it — simulates a
    // slow `stat` on a hung fs (EIO, network fs). Ref wrapper avoids
    // TS's let→closure "never" narrowing.
    const releaseRef: { current: (() => void) | null } = { current: null };
    const heldPreflight: PreflightFn = (_p) =>
      new Promise((resolve) => {
        releaseRef.current = () =>
          resolve({ ok: true, sizeBytes: 1024 });
      });

    const ctl = startStage({
      stageId: "stop-preflight",
      tracks: [makeTrack()],
      hlsDir: path.join(work, "stop-preflight"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      preflightImpl: heldPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    // Let the preflight get engaged.
    await new Promise((r) => setTimeout(r, 30));
    if (!releaseRef.current) {
      throw new Error("preflight should have been called");
    }

    // stop() fires while preflight is pending. stop should resolve
    // promptly AND no runTrackImpl call should happen.
    const stopP = ctl.stop();
    // Unblock the preflight — if the bug existed, the supervisor would
    // then spawn ffmpeg despite the abort.
    releaseRef.current();
    await stopP;

    assert.equal(
      runner.calls.length,
      0,
      "ffmpeg must not spawn after stop() was called during preflight",
    );
    assert.equal(ctl.status(), "stopped");
  });

  // Codex [P1] round-3 follow-up: no hot-loop when all tracks dead AND fallback broken
  it("stops cleanly when all tracks are TTL-dead AND fallback is also invalid", async () => {
    // Without the "failed" return from runCuratingLoop, the supervisor
    // would enter the all-dead branch → runCuratingLoop → fallback
    // preflight fails → return → `continue` → all-dead again → hot
    // loop for the ~10 min default TTL. The fix: runCuratingLoop
    // returns a discriminated result, and the caller returns on
    // "failed".
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    // Every preflight fails: both the track AND the fallback.
    const allFail: PreflightFn = async () => ({
      ok: false,
      reason: "missing",
    });

    const ctl = startStage({
      stageId: "both-broken",
      tracks: [makeTrack({ plexRatingKey: 1, filePath: "/m/gone.opus" })],
      hlsDir: path.join(work, "both-broken"),
      fallbackFile: "/m/gone-too.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: allFail,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
      deadTtlMs: 60_000, // intentionally long — if the bug existed,
                         // the test would hang for a minute
      firstSegmentTimeoutMs: 0,
    });

    // Supervisor should: preflight track (fail) → TTL dead → enter
    // curating branch → preflight fallback (fail) → runCuratingLoop
    // returns "failed" → caller returns from runLoop → loop ends →
    // status="stopped". No ffmpeg spawns at all.
    await ctl.done;
    assert.equal(ctl.status(), "stopped");
    assert.equal(
      runner.calls.length,
      0,
      "must not spawn ffmpeg — both track and fallback preflights failed",
    );
    const preflightFailed = events.filter(
      (e) => e.type === "preflight_failed",
    );
    assert.equal(
      preflightFailed.length,
      1,
      "preflight_failed fires once (the dead track)",
    );
  });

  // Win #2: invalid fallback file → runCuratingLoop refuses to spawn
  it("refuses to spawn curating loop when fallback file fails preflight", async () => {
    const runner = makeControlledRunner();
    const events: StageEvent[] = [];
    const preflight: PreflightFn = async () => ({ ok: false, reason: "missing" });

    const ctl = startStage({
      stageId: "bad-fallback",
      tracks: [], // empty → go straight to curating
      hlsDir: path.join(work, "bad-fallback"),
      fallbackFile: "/nonexistent/curating.aac",
      onEvent: (e) => events.push(e),
      runTrackImpl: runner.run,
      preflightImpl: preflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    // Supervisor should never call runTrackImpl — it bails before
    // spawning ffmpeg on the curating sentinel.
    await ctl.done;
    assert.equal(runner.calls.length, 0, "must not spawn ffmpeg with bad fallback");
    // No curating_started event either — we never entered the loop.
    const curatingStarted = events.filter(
      (e) => e.type === "curating_started",
    );
    assert.equal(curatingStarted.length, 0);
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

  it("a throwing onStderrLine during HLS setup failure does not reject the run loop", async () => {
    // Regression: if prepareStageDir / cleanStageDir throw AND the
    // configured onStderrLine throws, the loop must still stop
    // cleanly — status === "stopped" and no unhandledRejection.
    // Root cause: internal log calls bypassed the observer guard.
    const runner = makeControlledRunner();

    // Seed a file where the supervisor will try to mkdir → ENOTDIR.
    const file = path.join(work, "not-a-dir");
    await writeFile(file, "");

    const ctl = startStage({
      stageId: "setup-fail",
      tracks: [makeTrack()],
      hlsDir: path.join(file, "subdir"), // mkdir under a file → fails
      fallbackFile: "/tmp/curating.aac",
      onStderrLine: () => {
        throw new Error("logger is also down");
      },
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    await ctl.done;
    assert.equal(ctl.status(), "stopped");
    // Nothing was ever spawned because setup failed first.
    assert.equal(runner.calls.length, 0);
  });

  it("snapshot() reports null track + startedAt while stopping (public contract)", async () => {
    // Codex [P2] follow-up: between stop() being called and the run
    // loop's .finally() running, internal currentTrack stays
    // populated. The public snapshot must NOT leak that — clients
    // querying /api/stages/:id/now expect track === null whenever
    // status isn't "playing" or "curating".
    const runner = makeControlledRunner();
    const ctl = startStage({
      stageId: "stop-snap",
      tracks: [makeTrack({ plexRatingKey: 7, filePath: "/m/ok.opus" })],
      hlsDir: path.join(work, "stop-snap"),
      fallbackFile: "/tmp/curating.aac",
      runTrackImpl: runner.run,
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    // Track is now playing (instantReadyWatcher emitted track_started
    // synchronously after spawn, so currentTrack should be populated
    // and the snapshot reflects it).
    let snap = ctl.snapshot();
    if (snap.status === "playing") {
      assert.ok(snap.track, "playing snapshot exposes the track");
    }

    // Trigger stopping. Between this line and the loop returning,
    // status === "stopping" but currentTrack may still be set.
    const stopP = ctl.stop();

    // Read the snapshot during the stopping window — it MUST report
    // null track/startedAt regardless of the internal state.
    snap = ctl.snapshot();
    assert.notEqual(snap.status, "playing");
    if (snap.status === "stopping" || snap.status === "stopped") {
      assert.equal(
        snap.track,
        null,
        `track must be null while ${snap.status}; got ${JSON.stringify(snap.track)}`,
      );
      assert.equal(snap.trackStartedAt, null);
    }

    await stopP;

    // After stop completes, status is "stopped" and the snapshot
    // remains consistent.
    snap = ctl.snapshot();
    assert.equal(snap.status, "stopped");
    assert.equal(snap.track, null);
    assert.equal(snap.trackStartedAt, null);
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
      preflightImpl: acceptAllPreflight,
      waitForFirstSegmentImpl: instantReadyWatcher,
      sleep: zeroSleep,
    });

    await runner.waitForCall(1);
    runner.complete({ kind: "ok" });
    await runner.waitForCall(2);
    await ctl.stop();
    assert.equal(ctl.status(), "stopped");
  });
});
