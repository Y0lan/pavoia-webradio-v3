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
// Crash handling (Req: "crash restart with 500 ms backoff"):
//   - Non-zero exit → log, sleep restartBackoffMs, retry THE SAME track.
//   - After maxConsecutiveCrashes in a row on the same track, emit
//     `skipped_after_repeated_crashes` and advance — this is the escape
//     hatch so a single corrupt file can't hot-loop the supervisor.
//   - A successful run resets the crash counter.
//
// Graceful stop:
//   - stop() aborts the AbortController, which:
//       (a) signals the active ffmpeg via runner → SIGTERM → SIGKILL
//       (b) wakes any in-progress backoff sleep → loop exits
//   - stop() resolves after the run loop has finished; safe to call
//     multiple times concurrently.
//
// This module intentionally performs NO networking, NO Plex polling,
// NO /api routing. Wiring lives in Task 5 (engine index.ts).

import type { Track } from "@pavoia/shared";

import { buildFfmpegArgs } from "./ffmpeg-args.ts";
import { cleanStageDir, prepareStageDir } from "./hls-dir.ts";
import { runTrack, type RunTrackInput, type TrackExit } from "./runner.ts";

const DEFAULT_RESTART_BACKOFF_MS = 500;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;

export type StageStatus =
  | "starting"
  | "playing"
  | "curating"
  | "stopping"
  | "stopped";

export type StageEvent =
  | { type: "status"; status: StageStatus }
  | { type: "track_started"; track: Track; startedAt: number }
  | { type: "track_ended"; track: Track; exit: TrackExit }
  | { type: "curating_started"; startedAt: number }
  | { type: "curating_ended"; exit: TrackExit }
  | { type: "crash"; track: Track | null; exit: TrackExit; consecutive: number }
  | { type: "skipped_after_repeated_crashes"; track: Track };

/** Minimal, testable injection surface for the runner. */
export type RunTrackFn = (input: RunTrackInput) => Promise<TrackExit>;

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
  /** After N consecutive crashes on the same track, advance. Default 3. */
  maxConsecutiveCrashes?: number;
  /** Grace period between SIGTERM and SIGKILL on stop. Default 5000 ms. */
  killTimeoutMs?: number;
  /** Observer for the supervisor's state machine. Default: no-op. */
  onEvent?: (event: StageEvent) => void;
  /** Per-line ffmpeg stderr drain. Default: no-op. */
  onStderrLine?: (line: string) => void;
  /** Injectable for tests. Default: real `runTrack`. */
  runTrackImpl?: RunTrackFn;
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
    killTimeoutMs = 5000,
    onEvent = () => {},
    onStderrLine = () => {},
    runTrackImpl = runTrack,
    sleep = defaultSleep,
  } = config;
  // Defensive shallow copy so an external mutation of the caller's
  // array after startStage() has returned cannot change the supervisor's
  // iteration order or inject/remove tracks mid-run. The `readonly`
  // TypeScript constraint is a compile-time hint only — a caller could
  // cast it away.
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
  // Same guard for onStderrLine: a throwing logger must never reject
  // the run loop or leak as an unhandledRejection. The runner already
  // wraps its own stderr pipe; this covers the supervisor's own internal
  // log lines (hls-dir setup failure, repeated fallback crashes, fatal
  // catch-all, etc.).
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

  const runOne = (
    track: Track,
    loopInput: boolean,
  ): Promise<TrackExit> => {
    const argv = buildFfmpegArgs({
      trackFilePath: track.filePath,
      stageHlsDir: hlsDir,
      loopInput,
    });
    return runTrackImpl({
      ffmpegBin,
      argv,
      signal: ac.signal,
      onStderrLine,
      killTimeoutMs,
    });
  };

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

    // Tracks that exceeded maxConsecutiveCrashes this session are
    // marked dead and not re-selected. When all tracks are dead we
    // transition to the curating fallback — this is what prevents a
    // single-track playlist with a corrupt file from hot-looping the
    // crash cap forever.
    const deadTracks = new Set<number>();
    let i = 0;
    while (!ac.signal.aborted) {
      if (deadTracks.size >= tracks.length) break; // all dead → curating
      // Advance past any already-dead track. Safe because the guard
      // above proves at least one track is alive.
      while (deadTracks.has(i)) i = (i + 1) % tracks.length;

      const track = tracks[i];
      if (!track) {
        // Defensive: shouldn't happen given i is bounded, but satisfies
        // noUncheckedIndexedAccess and guards a future bug.
        break;
      }
      currentTrack = track;
      setStatus("playing");

      let consecutiveCrashes = 0;
      while (!ac.signal.aborted) {
        const startedAt = Date.now();
        emit({ type: "track_started", track, startedAt });

        const exit = await runOne(track, false);

        emit({ type: "track_ended", track, exit });

        if (exit.kind === "ok") {
          break; // advance
        }
        if (exit.kind === "aborted") {
          return;
        }
        consecutiveCrashes++;
        emit({ type: "crash", track, exit, consecutive: consecutiveCrashes });

        if (consecutiveCrashes >= maxConsecutiveCrashes) {
          emit({ type: "skipped_after_repeated_crashes", track });
          deadTracks.add(i);
          break;
        }
        const slept = await sleepOrAbort(restartBackoffMs);
        if (!slept) return;
      }

      if (ac.signal.aborted) return;
      i = (i + 1) % tracks.length;
    }

    // All tracks exhausted without a successful run — fall through to
    // the fallback loop so the stage still produces a stream.
    if (!ac.signal.aborted && deadTracks.size >= tracks.length) {
      await runCuratingLoop();
    }
  }

  async function runCuratingLoop(): Promise<void> {
    // With -stream_loop -1 ffmpeg should only exit when aborted. If it
    // crashes, restart with backoff — same cap as per-track.
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

      const exit = await runOne(sentinel, true);

      emit({ type: "curating_ended", exit });

      if (exit.kind === "aborted") return;

      if (exit.kind === "ok") {
        // With -stream_loop -1 ffmpeg is expected to run until aborted,
        // not to exit cleanly. A clean exit is unexpected but NOT a
        // crash — don't emit { type: "crash" } or bump the crash
        // counter. Back off briefly so we don't hot-loop if whatever
        // edge case caused the exit (e.g. unreadable fallback file
        // that ffmpeg just closes) is sticky.
        consecutiveCrashes = 0;
        const slept = await sleepOrAbort(restartBackoffMs);
        if (!slept) return;
        continue;
      }

      consecutiveCrashes++;
      emit({
        type: "crash",
        track: null,
        exit,
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
    // Perfect idempotency: concurrent stop() callers share the identical
    // promise, not separate microtask chains.
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
