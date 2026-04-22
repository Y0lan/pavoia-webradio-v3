// Per-stage ffmpeg supervisor.
//
// Owns one stage's HLS output directory and runs a sequential ffmpeg
// loop inside it:
//
//   tracks.length > 0 →  spawn ffmpeg for tracks[0], wait for exit,
//                        advance, spawn ffmpeg for tracks[1], … wrap
//                        around at tracks.length (Req K + N).
//   tracks.length === 0 → spawn ffmpeg -stream_loop -1 on the fallback
//                        file; only exits when the supervisor aborts
//                        it (Req O — "curating…").
//
// Hardening (Codex challenge, 2026-04-22):
//   - Pre-flight every track with a cheap `fs.stat` before spawning
//     ffmpeg, so missing / empty / non-regular files never cause the
//     1.7 s crash-retry-skip window that has no HLS buffer to hide
//     behind on cold start.
//   - Dead-track TTL: a track that exceeds the crash cap or fails
//     preflight is marked unavailable for `deadTtlMs` (default 10
//     minutes), not permanently. Transient fs hiccups recover on their
//     own; genuinely corrupt files stay skipped for a while but come
//     back into rotation later (Plex rescan / admin repair).
//   - Watchdog: if ffmpeg spawns but no segment hits disk within
//     `firstSegmentTimeoutMs` (default 5 s), we assume a hang (libav
//     stalling on an unreadable file, kernel stall), abort the child,
//     and treat the outcome as a synthetic crash.
//   - Honest track_started: the event fires only after the first
//     seg-*.ts lands on disk. Before that moment we don't claim the
//     track is "now playing".
//   - Fallback preflight: when entering the curating loop we validate
//     the fallback file. If it's missing / empty / bad, we log and
//     exit cleanly rather than hot-looping `-stream_loop -1` failures.
//
// Graceful stop:
//   - stop() aborts the stage-wide AbortController, which:
//       (a) signals the active ffmpeg via runner → SIGTERM → SIGKILL
//       (b) wakes any in-progress backoff sleep → loop exits
//       (c) cancels any in-flight first-segment watcher
//   - stop() resolves after the run loop has finished; safe to call
//     multiple times concurrently.
//
// This module intentionally performs NO networking, NO Plex polling,
// NO /api routing. Wiring lives in Task 5 (engine index.ts).

import type { Track } from "@pavoia/shared";

import { buildFfmpegArgs } from "./ffmpeg-args.ts";
import { cleanStageDir, prepareStageDir } from "./hls-dir.ts";
import {
  preflightTrack,
  type PreflightReason,
  type PreflightResult,
} from "./preflight.ts";
import { runTrack, type RunTrackInput, type TrackExit } from "./runner.ts";
import {
  waitForFirstSegment,
  type WaitForFirstSegmentInput,
  type WaitResult,
} from "./watchers.ts";

const DEFAULT_RESTART_BACKOFF_MS = 500;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;
const DEFAULT_DEAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_FIRST_SEGMENT_TIMEOUT_MS = 5000;

export type StageStatus =
  | "starting"
  | "playing"
  | "curating"
  | "stopping"
  | "stopped";

export type StageEvent =
  | { type: "status"; status: StageStatus }
  | { type: "preflight_failed"; track: Track; reason: PreflightReason }
  | { type: "track_started"; track: Track; startedAt: number }
  | { type: "track_ended"; track: Track; exit: TrackExit }
  | { type: "watchdog_timeout"; track: Track; timeoutMs: number }
  | { type: "curating_started"; startedAt: number }
  | { type: "curating_ended"; exit: TrackExit }
  | { type: "crash"; track: Track | null; exit: TrackExit; consecutive: number }
  | { type: "skipped_after_repeated_crashes"; track: Track };

/** Minimal, testable injection surface for the runner. */
export type RunTrackFn = (input: RunTrackInput) => Promise<TrackExit>;

/** Injectable hook for the first-segment watcher. Defaults to the
 *  real filesystem-polling implementation. Tests can stub to "ready"
 *  (to exercise the steady-state path) or "timeout" (watchdog). */
export type WaitForFirstSegmentFn = (
  input: WaitForFirstSegmentInput,
) => Promise<WaitResult>;

/** Injectable hook for track pre-flight. Defaults to `fs.stat`-based
 *  `preflightTrack`. */
export type PreflightFn = (filePath: string) => Promise<PreflightResult>;

export interface StartStageConfig {
  /** Used only for log prefixes + event payloads; no validation. */
  stageId: string;
  /** Shallow-copied at start; later mutation of the caller's array
   *  has no effect on the supervisor. */
  tracks: readonly Track[];
  /** Absolute HLS output directory (e.g. /dev/shm/1008/radio-hls/<stage>). */
  hlsDir: string;
  /** Absolute path to the curating/silence fallback file (Req O). */
  fallbackFile: string;
  /** Defaults to "ffmpeg" on PATH. */
  ffmpegBin?: string;
  /** Delay between a crashed ffmpeg and the retry. Default 500 ms. */
  restartBackoffMs?: number;
  /** After N consecutive crashes on the same track, mark dead for
   *  deadTtlMs. Default 3. */
  maxConsecutiveCrashes?: number;
  /** How long a track stays "dead" after a crash cap hit or preflight
   *  failure before being re-tried. Default 10 minutes. Transient
   *  I/O / permission hiccups recover inside this window. */
  deadTtlMs?: number;
  /** If ffmpeg produces no seg-*.ts within this window after spawn,
   *  watchdog kills the child and treats as crash. Default 5000 ms.
   *  Set to 0 or negative to disable the watchdog (and emit
   *  track_started immediately on spawn — matches the pre-hardening
   *  behavior). */
  firstSegmentTimeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. Default 5000 ms. */
  killTimeoutMs?: number;
  /** Observer for the supervisor's state machine. Default: no-op. */
  onEvent?: (event: StageEvent) => void;
  /** Per-line ffmpeg stderr drain. Default: no-op. */
  onStderrLine?: (line: string) => void;
  /** Injectable for tests. Default: real `runTrack`. */
  runTrackImpl?: RunTrackFn;
  /** Injectable for tests. Default: real `waitForFirstSegment`. */
  waitForFirstSegmentImpl?: WaitForFirstSegmentFn;
  /** Injectable for tests. Default: real `preflightTrack`. */
  preflightImpl?: PreflightFn;
  /** Injectable for tests. Default: real `setTimeout`. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface StageController {
  readonly stageId: string;
  status(): StageStatus;
  currentTrack(): Track | null;
  /** Resolves after the supervisor's run loop has exited. */
  stop(): Promise<void>;
  /** Same promise returned from stop(); also resolves on a fatal error. */
  readonly done: Promise<void>;
}

export function startStage(config: StartStageConfig): StageController {
  const {
    stageId,
    hlsDir,
    fallbackFile,
    ffmpegBin = "ffmpeg",
    restartBackoffMs = DEFAULT_RESTART_BACKOFF_MS,
    maxConsecutiveCrashes = DEFAULT_MAX_CONSECUTIVE_CRASHES,
    deadTtlMs = DEFAULT_DEAD_TTL_MS,
    firstSegmentTimeoutMs = DEFAULT_FIRST_SEGMENT_TIMEOUT_MS,
    killTimeoutMs = 5000,
    onEvent = () => {},
    onStderrLine = () => {},
    runTrackImpl = runTrack,
    waitForFirstSegmentImpl = waitForFirstSegment,
    preflightImpl = preflightTrack,
    sleep = defaultSleep,
  } = config;
  const tracks: readonly Track[] = [...config.tracks];

  const ac = new AbortController();
  let status: StageStatus = "starting";
  let currentTrack: Track | null = null;

  const emit = (ev: StageEvent): void => {
    try {
      onEvent(ev);
    } catch {
      // Never let an observer bug take the stage down.
    }
  };
  const safeLog = (line: string): void => {
    try {
      onStderrLine(line);
    } catch {
      /* ignore */
    }
  };
  const setStatus = (s: StageStatus): void => {
    if (status === s) return;
    status = s;
    emit({ type: "status", status: s });
  };

  /**
   * Run one ffmpeg invocation with a first-segment watchdog + deferred
   * track_started emission. Returns an outcome that the caller can
   * treat uniformly:
   *
   *   ok        — ffmpeg exited with code 0 (natural track end).
   *   aborted   — stage-wide abort (stop()).
   *   crashed   — any other outcome: non-zero exit, signal death,
   *               spawn error, or watchdog timeout (synthetic).
   *   preflight — we never spawned; the preflight said the file is bad.
   */
  async function runOneWithWatchdog(
    track: Track,
    loopInput: boolean,
  ): Promise<
    | { kind: "ok"; started: boolean }
    | { kind: "aborted" }
    | { kind: "crashed"; exit: TrackExit; watchdog: boolean }
    | { kind: "preflight"; reason: PreflightReason }
  > {
    // 1. Preflight — skip the whole spawn path if the file is bad.
    const pre = await preflightImpl(track.filePath);
    if (!pre.ok) {
      return { kind: "preflight", reason: pre.reason };
    }

    // 2. Per-run AbortController derived from the stage one. The
    //    watchdog can abort the child without aborting the whole
    //    stage.
    const runAc = new AbortController();
    const linkStageAbort = () => runAc.abort();
    ac.signal.addEventListener("abort", linkStageAbort, { once: true });

    const argv = buildFfmpegArgs({
      trackFilePath: track.filePath,
      stageHlsDir: hlsDir,
      loopInput,
    });

    const runPromise = runTrackImpl({
      ffmpegBin,
      argv,
      signal: runAc.signal,
      onStderrLine,
      killTimeoutMs,
    });

    // 3. Race: first segment landing vs ffmpeg exiting vs watchdog
    //    timeout. `waitForFirstSegmentImpl` honors its signal so a
    //    stage abort wakes it.
    let watchdogFired = false;
    let trackStartedEmitted = false;
    if (firstSegmentTimeoutMs > 0) {
      const segPromise = waitForFirstSegmentImpl({
        hlsDir,
        signal: runAc.signal,
        timeoutMs: firstSegmentTimeoutMs,
      });
      const winner = await Promise.race([
        runPromise.then(() => "exited" as const),
        segPromise.then((r) => ({ seg: r })),
      ]);

      if (winner === "exited") {
        // ffmpeg finished before any segment landed — no track_started
        // emitted. The exit-kind switch below classifies the outcome.
      } else if (winner.seg === "ready") {
        // Honest track_started: first audio on disk, now we claim it.
        // `currentTrack` is updated in lockstep so the API (and any
        // downstream WebSocket feed) reports the playing track for the
        // full duration of the audible window, not just momentarily
        // around the track_ended event.
        currentTrack = track;
        trackStartedEmitted = true;
        emit({ type: "track_started", track, startedAt: Date.now() });
      } else if (winner.seg === "timeout") {
        // Watchdog: kill the stuck ffmpeg and classify as crashed.
        watchdogFired = true;
        runAc.abort();
      } else {
        // seg === "aborted" — stage abort reached the watcher first;
        // runPromise is about to resolve as aborted too.
      }
    } else {
      // Watchdog disabled: preserve the legacy behavior of emitting
      // track_started at spawn time. currentTrack is set at the same
      // moment for API consistency.
      currentTrack = track;
      trackStartedEmitted = true;
      emit({ type: "track_started", track, startedAt: Date.now() });
    }

    // 4. Always await runPromise so we don't leave a zombie promise
    //    or a child still draining stderr.
    const exit = await runPromise;
    ac.signal.removeEventListener("abort", linkStageAbort);

    // 5. Classify.
    if (watchdogFired) {
      emit({ type: "watchdog_timeout", track, timeoutMs: firstSegmentTimeoutMs });
      return {
        kind: "crashed",
        exit: { kind: "crashed", code: null, signal: null },
        watchdog: true,
      };
    }
    if (ac.signal.aborted) return { kind: "aborted" };
    if (exit.kind === "ok") {
      // If we disabled the watchdog OR never saw a first segment but
      // ffmpeg still exited 0, the run is "ok" from ffmpeg's point
      // of view. `started` tells the caller whether track_started was
      // emitted, so it can keep track_started/track_ended paired.
      return { kind: "ok", started: trackStartedEmitted };
    }
    if (exit.kind === "aborted") return { kind: "aborted" };
    return { kind: "crashed", exit, watchdog: false };
  }

  /** TTL-aware dead-track map: index → epoch ms when the track becomes
   *  retryable again. */
  type DeadUntil = Map<number, number>;

  function isDead(deadUntil: DeadUntil, i: number): boolean {
    const until = deadUntil.get(i);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      deadUntil.delete(i);
      return false;
    }
    return true;
  }

  function countDead(deadUntil: DeadUntil): number {
    let n = 0;
    for (const [i, until] of deadUntil) {
      if (Date.now() >= until) deadUntil.delete(i);
      else n++;
    }
    return n;
  }

  async function runLoop(): Promise<void> {
    try {
      await prepareStageDir(hlsDir);
      await cleanStageDir(hlsDir);
    } catch (err) {
      safeLog(
        `[stage:${stageId}] hls dir setup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }

    if (ac.signal.aborted) return;

    if (tracks.length === 0) {
      await runCuratingLoop();
      return;
    }

    const deadUntil: DeadUntil = new Map();
    let i = 0;
    while (!ac.signal.aborted) {
      if (countDead(deadUntil) >= tracks.length) break; // all dead → curating
      while (isDead(deadUntil, i)) i = (i + 1) % tracks.length;

      const track = tracks[i];
      if (!track) break;

      // We DON'T set currentTrack yet — track_started is emitted
      // after first segment inside runOneWithWatchdog, and that's
      // the moment currentTrack gets populated.
      setStatus("playing");

      let consecutiveCrashes = 0;
      let advance = false;
      while (!ac.signal.aborted && !advance) {
        const outcome = await runOneWithWatchdog(track, false);

        if (outcome.kind === "preflight") {
          emit({ type: "preflight_failed", track, reason: outcome.reason });
          deadUntil.set(i, Date.now() + deadTtlMs);
          advance = true;
          break;
        }
        if (outcome.kind === "aborted") return;
        if (outcome.kind === "ok") {
          // Clean track end. Only emit track_ended if runOneWithWatchdog
          // actually emitted a paired track_started (i.e., a first
          // segment landed on disk). The rare path where ffmpeg exits
          // 0 before producing any segment — a sub-3-s track with -re
          // is the most plausible cause — produces neither event; the
          // track effectively didn't play.
          if (outcome.started) {
            emit({ type: "track_ended", track, exit: { kind: "ok" } });
            currentTrack = null;
          }
          advance = true;
          break;
        }

        // crashed — either synthetic watchdog or real non-zero exit.
        consecutiveCrashes++;
        // If runOneWithWatchdog emitted track_started before the crash
        // (i.e. a first segment landed, then ffmpeg died mid-track),
        // currentTrack was set. Clear it now — the "now playing"
        // claim is no longer true, and the crash branch doesn't emit
        // a paired track_ended.
        currentTrack = null;
        // Don't emit track_ended here: consumers expect it paired
        // with track_started, and crash/watchdog paths don't always
        // emit track_started.
        emit({
          type: "crash",
          track,
          exit: outcome.exit,
          consecutive: consecutiveCrashes,
        });

        if (consecutiveCrashes >= maxConsecutiveCrashes) {
          emit({ type: "skipped_after_repeated_crashes", track });
          deadUntil.set(i, Date.now() + deadTtlMs);
          advance = true;
          break;
        }
        const slept = await sleepOrAbort(restartBackoffMs);
        if (!slept) return;
      }

      if (ac.signal.aborted) return;
      i = (i + 1) % tracks.length;
    }

    // All tracks have expired into deadUntil and none is retryable
    // right now — fall through to the curating fallback so the stage
    // still produces a stream. currentTrack is cleared first so
    // callers don't see a stale now-playing.
    if (!ac.signal.aborted && countDead(deadUntil) >= tracks.length) {
      currentTrack = null;
      await runCuratingLoop();
    }
  }

  async function runCuratingLoop(): Promise<void> {
    // Validate the fallback file BEFORE spawning. A broken fallback is
    // fatal for this stage — nothing we can play, don't hot-loop
    // -stream_loop -1 failures.
    const pre = await preflightImpl(fallbackFile);
    if (!pre.ok) {
      safeLog(
        `[stage:${stageId}] fallback file invalid (${pre.reason}${
          pre.detail ? `: ${pre.detail}` : ""
        }) — stopping`,
      );
      return;
    }

    const sentinel: Track = {
      plexRatingKey: 0,
      fallbackHash: "",
      title: "Curating",
      artist: "Pavoia",
      album: "Fallback",
      albumYear: null,
      durationSec: 0,
      filePath: fallbackFile,
      coverUrl: null,
    };

    let consecutiveCrashes = 0;
    while (!ac.signal.aborted) {
      const startedAt = Date.now();
      emit({ type: "curating_started", startedAt });
      setStatus("curating");

      const outcome = await runOneWithWatchdog(sentinel, true);

      // Emit curating_ended with the TrackExit-shaped outcome for
      // observability parity with track_ended.
      const exit: TrackExit =
        outcome.kind === "ok"
          ? { kind: "ok" }
          : outcome.kind === "aborted"
            ? { kind: "aborted" }
            : outcome.kind === "preflight"
              ? { kind: "crashed", code: null, signal: null }
              : outcome.exit;
      emit({ type: "curating_ended", exit });

      if (outcome.kind === "aborted") return;

      if (outcome.kind === "preflight") {
        // Fallback became invalid mid-loop (symlink swap, deletion).
        safeLog(
          `[stage:${stageId}] fallback file became invalid (${outcome.reason}) — stopping`,
        );
        return;
      }

      if (outcome.kind === "ok") {
        // -stream_loop -1 shouldn't exit cleanly; if it does, restart
        // with backoff but do not count as a crash.
        consecutiveCrashes = 0;
        const slept = await sleepOrAbort(restartBackoffMs);
        if (!slept) return;
        continue;
      }

      consecutiveCrashes++;
      emit({
        type: "crash",
        track: null,
        exit: outcome.exit,
        consecutive: consecutiveCrashes,
      });

      if (consecutiveCrashes >= maxConsecutiveCrashes) {
        safeLog(
          `[stage:${stageId}] fallback crashed ${consecutiveCrashes} times — stopping`,
        );
        return;
      }
      const slept = await sleepOrAbort(restartBackoffMs);
      if (!slept) return;
    }
  }

  async function sleepOrAbort(ms: number): Promise<boolean> {
    try {
      await sleep(ms, ac.signal);
      return !ac.signal.aborted;
    } catch {
      return false;
    }
  }

  const loop = runLoop()
    .catch((err) => {
      safeLog(
        `[stage:${stageId}] fatal: ${err instanceof Error ? err.message : String(err)}`,
      );
    })
    .finally(() => {
      currentTrack = null;
      setStatus("stopped");
    });

  let stopPromise: Promise<void> | null = null;
  function stop(): Promise<void> {
    if (status === "stopped") return Promise.resolve();
    if (stopPromise) return stopPromise;
    if (!ac.signal.aborted) {
      setStatus("stopping");
      ac.abort();
    }
    stopPromise = loop;
    return stopPromise;
  }

  return {
    stageId,
    status: () => status,
    currentTrack: () => currentTrack,
    stop,
    done: loop,
  };
}

export function defaultSleep(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new Error("aborted"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
