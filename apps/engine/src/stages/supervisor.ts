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

import type { StageStatus, Track } from "@pavoia/shared";

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
  snapshotExistingSegments,
  type WaitForFirstSegmentInput,
  type WaitResult,
} from "./watchers.ts";

const DEFAULT_RESTART_BACKOFF_MS = 500;
const DEFAULT_MAX_CONSECUTIVE_CRASHES = 3;
const DEFAULT_DEAD_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_FIRST_SEGMENT_TIMEOUT_MS = 5000;
/** Margin added to the curating-deadline timer so it fires AFTER the
 *  TTL has definitely elapsed (Date.now() is float, setTimeout truncates
 *  to int — without grace, the timer can fire just before the TTL
 *  timestamp and the outer loop re-enters the all-dead branch). */
const DEADLINE_GRACE_MS = 5;

// StageStatus is defined in @pavoia/shared so the web side can use the
// same type. Re-exported here for engine-internal convenience.
export type { StageStatus };

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

/**
 * Atomic snapshot of a stage's now-playing state. Returned by
 * `StageController.snapshot()` so HTTP handlers can read all related
 * fields in one go (no race between separate getters).
 */
export interface StageSnapshot {
  status: StageStatus;
  /** The currently audible track. `null` during curating, before the
   *  first segment lands, or while stopped/stopping. */
  track: Track | null;
  /** Epoch ms when the current track's first segment hit disk. `null`
   *  whenever `track` is `null`. */
  trackStartedAt: number | null;
}

export interface StageController {
  readonly stageId: string;
  status(): StageStatus;
  currentTrack(): Track | null;
  /** Read-once snapshot of status + track + startedAt. Atomic w.r.t.
   *  the run-loop's writes. */
  snapshot(): StageSnapshot;
  /**
   * Queue a new track list. The current track keeps playing until
   * its natural end (or current backoff/retry resolves) — then the
   * supervisor swaps to the new list at the track-boundary moment.
   * This is what makes routine Plex playlist edits inaudible to
   * listeners, per SLIM_V3 §"Audio engine".
   *
   * Calling setTracks again before a previously queued list has been
   * applied REPLACES the pending queue (most-recent intent wins —
   * not coalesced). Empty array is valid: at the next boundary the
   * supervisor falls into the curating loop.
   *
   * Side effect: clears the dead-track TTL state so the new list
   * starts fresh — track indices no longer correspond to the old
   * Plex order, and a previously-corrupt file may have been replaced.
   */
  setTracks(tracks: readonly Track[]): void;
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
  // Mutable now (was readonly snapshot). The current track list is
  // swapped at the next track boundary by applying pendingTracksUpdate.
  let tracks: readonly Track[] = [...config.tracks];
  let pendingTracksUpdate: readonly Track[] | null = null;

  const ac = new AbortController();
  let status: StageStatus = "starting";
  let currentTrack: Track | null = null;
  let currentTrackStartedAt: number | null = null;
  /** ratingKey of the most recently completed track (ok exit only).
   *  Used at pendingTracksUpdate-swap time to preserve rotation
   *  position across Plex edits — without this, every curator edit
   *  jumps back to index 0 of the new list, starving later tracks. */
  let lastCompletedRatingKey: number | null = null;
  /** Set while a curating iteration's ffmpeg is in flight. setTracks
   *  aborts this so the supervisor wakes up and switches over to the
   *  new playlist immediately rather than waiting for the bounded
   *  curating timeout. Always null while playing a real track. */
  let activeCuratingAc: AbortController | null = null;

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
    // 1a. If the stage was stopped WHILE preflight was in-flight, we
    //     must NOT spawn ffmpeg — the derived runAc would inherit an
    //     already-aborted signal and the runner's abort listener
    //     (registered with { once: true }) would never fire, so the
    //     child would run to completion while stop() hangs waiting
    //     for the run loop.
    if (ac.signal.aborted) return { kind: "aborted" };

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

    // Snapshot the segments already on disk BEFORE spawning. The
    // supervisor deliberately preserves seg-*.ts across track
    // boundaries (HLS client safety buffer), so without this snapshot
    // the watcher would see the previous track's tail segments and
    // falsely return "ready" immediately — defeating the watchdog for
    // mid-playlist hangs.
    const preSpawnSegments = await snapshotExistingSegments(hlsDir);

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
        ignoreExisting: preSpawnSegments,
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
        // `currentTrack` + `currentTrackStartedAt` are updated in
        // lockstep so a snapshot read by the HTTP layer is consistent.
        const startedAt = Date.now();
        currentTrack = track;
        currentTrackStartedAt = startedAt;
        trackStartedEmitted = true;
        emit({ type: "track_started", track, startedAt });
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
      // track_started at spawn time. currentTrack + startedAt are
      // set at the same moment for API consistency.
      const startedAt = Date.now();
      currentTrack = track;
      currentTrackStartedAt = startedAt;
      trackStartedEmitted = true;
      emit({ type: "track_started", track, startedAt });
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

    const deadUntil: DeadUntil = new Map();
    let i = 0;
    while (!ac.signal.aborted) {
      // Apply a pending track-list update at this safe boundary —
      // between tracks, before we pick the next one. This is what
      // makes routine Plex playlist edits inaudible to listeners
      // (per SLIM_V3 §"Audio engine"). Indices into deadUntil no
      // longer correspond to the new ordering, so wipe it; a
      // previously-corrupt file may have been replaced anyway.
      //
      // Preserve rotation position across the swap: if the most
      // recently completed track is still in the new list, resume
      // from after it. Without this, every curator edit (even an
      // append) jumps back to index 0 and starves later tracks.
      if (pendingTracksUpdate !== null) {
        tracks = pendingTracksUpdate;
        pendingTracksUpdate = null;
        deadUntil.clear();
        if (lastCompletedRatingKey !== null && tracks.length > 0) {
          const idx = tracks.findIndex(
            (t) => t.plexRatingKey === lastCompletedRatingKey,
          );
          // Found → continue past it; not found (track was removed)
          // OR no prior track played → start from the top.
          i = idx >= 0 ? (idx + 1) % tracks.length : 0;
        } else {
          i = 0;
        }
      }

      if (tracks.length === 0) {
        // No real tracks → curating until either the stage is
        // aborted, the fallback fails, or setTracks wakes us.
        currentTrack = null;
        const result = await runCuratingLoop();
        if (result === "aborted" || result === "failed") return;
        continue; // "wakeup" — re-check pendingTracksUpdate
      }

      if (countDead(deadUntil) >= tracks.length) {
        // Every real track is TTL'd dead. Bounded curating until
        // the earliest expiry, then loop back to retry a track.
        // setTracks can also wake us early.
        const untils = Array.from(deadUntil.values());
        const earliest = untils.length > 0 ? Math.min(...untils) : undefined;
        currentTrack = null;
        const result = await runCuratingLoop(earliest);
        if (result === "aborted" || result === "failed") return;
        continue;
      }
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
            currentTrackStartedAt = null;
          }
          lastCompletedRatingKey = track.plexRatingKey;
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
        currentTrackStartedAt = null;
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

    // NOTE: the "all tracks dead" transition is handled inside the
    // while loop above via bounded runCuratingLoop(earliestExpiry),
    // so dead-TTL expiries can bring tracks back. We don't need a
    // trailing fallback here.
  }

  /**
   * Runs the fallback in -stream_loop -1 mode.
   *
   * When `until` is provided, the loop returns at or before that wall
   * time so the outer track loop can re-check whether any dead track
   * has become retryable. When `until` is omitted (empty-playlist
   * case), the loop runs until the stage is aborted OR setTracks
   * queues a new playlist (which aborts the in-flight ffmpeg via
   * activeCuratingAc so the supervisor wakes up promptly).
   *
   * Return value tells the caller what happened so it can decide
   * whether to re-enter the track loop or give up:
   *   - "aborted" — stage-wide stop; caller should return.
   *   - "wakeup" — either the `until` deadline hit or setTracks
   *     queued a new list. Caller should re-check pendingTracksUpdate
   *     + deadUntil.
   *   - "failed" — fallback is unusable (preflight invalid, or it hit
   *     the consecutive-crash cap). Caller should give up on the
   *     stage entirely; re-entering all-dead → curating would just
   *     hot-loop stat/spawn until TTL expires.
   */
  async function runCuratingLoop(
    until?: number,
  ): Promise<"aborted" | "wakeup" | "failed"> {
    // Validate the fallback file once up front. A broken fallback is
    // fatal — nothing we can play, don't hot-loop -stream_loop -1.
    const pre = await preflightImpl(fallbackFile);
    if (!pre.ok) {
      safeLog(
        `[stage:${stageId}] fallback file invalid (${pre.reason}${
          pre.detail ? `: ${pre.detail}` : ""
        }) — stopping`,
      );
      return "failed";
    }

    let consecutiveCrashes = 0;
    while (!ac.signal.aborted) {
      if (until !== undefined && Date.now() >= until) return "wakeup";
      // setTracks may have queued a new playlist while we were here —
      // wake up so the outer loop can switch to it.
      if (pendingTracksUpdate !== null) return "wakeup";

      const startedAt = Date.now();
      emit({ type: "curating_started", startedAt });
      setStatus("curating");

      // Per-iteration controller so the deadline timer (or setTracks)
      // can end JUST this curating run without killing the whole
      // stage. Stage abort also aborts it; the runner translates
      // either into SIGTERM on ffmpeg.
      const curAc = new AbortController();
      const linkStage = () => curAc.abort();
      ac.signal.addEventListener("abort", linkStage, { once: true });
      // Expose to setTracks so it can wake us up promptly.
      activeCuratingAc = curAc;

      let deadlineHit = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      if (until !== undefined) {
        // Add a small grace to ensure the timer fires AFTER the TTL
        // has definitely elapsed. setTimeout uses integer ms; Date.now()
        // is floating-point; without the grace, the timer can fire a
        // sub-millisecond BEFORE `until`, making the outer loop's
        // `Date.now() >= until` check fail and re-enter the all-dead
        // branch immediately. CI exposes this race that local doesn't.
        const remaining = Math.max(0, until - Date.now()) + DEADLINE_GRACE_MS;
        deadlineTimer = setTimeout(() => {
          deadlineHit = true;
          curAc.abort();
        }, remaining);
      }

      const argv = buildFfmpegArgs({
        trackFilePath: fallbackFile,
        stageHlsDir: hlsDir,
        loopInput: true,
      });
      const exit = await runTrackImpl({
        ffmpegBin,
        argv,
        signal: curAc.signal,
        onStderrLine,
        killTimeoutMs,
      });
      ac.signal.removeEventListener("abort", linkStage);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      activeCuratingAc = null;

      emit({ type: "curating_ended", exit });

      if (deadlineHit) return "wakeup"; // re-enter track loop
      if (ac.signal.aborted) return "aborted";
      // setTracks woke us — pendingTracksUpdate is set, return so the
      // outer loop applies it. Distinguishable from a stage abort
      // because ac.signal.aborted is false.
      if (pendingTracksUpdate !== null) return "wakeup";

      if (exit.kind === "aborted") return "aborted";

      if (exit.kind === "ok") {
        // -stream_loop -1 shouldn't exit cleanly; if it does, restart
        // with backoff but do not count as a crash.
        consecutiveCrashes = 0;
        const slept = await sleepOrAbort(restartBackoffMs);
        if (!slept) return "aborted";
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
        return "failed";
      }
      const slept = await sleepOrAbort(restartBackoffMs);
      if (!slept) return "aborted";
    }
    return "aborted";
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
      currentTrackStartedAt = null;
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

  function setTracks(newTracks: readonly Track[]): void {
    pendingTracksUpdate = [...newTracks]; // defensive copy, like at start
    // If we're currently in a curating run, abort it so the outer
    // loop wakes up and switches to the new playlist immediately.
    // Track-loop iterations apply the update at the natural next
    // boundary — no abort needed there.
    if (activeCuratingAc) {
      activeCuratingAc.abort();
    }
  }

  return {
    stageId,
    status: () => status,
    currentTrack: () => currentTrack,
    snapshot: () => {
      // Normalize the public snapshot to match the documented contract:
      // `track` and `trackStartedAt` are null whenever the stage is not
      // actively producing audio for a real track. The internal vars
      // stay populated until the run loop's .finally() clears them
      // (useful for debugging via direct currentTrack() access), but
      // the public surface used by /api/stages/:id/now is always
      // truthful.
      const audible = status === "playing" || status === "curating";
      return {
        status,
        track: audible ? currentTrack : null,
        trackStartedAt: audible ? currentTrackStartedAt : null,
      };
    },
    setTracks,
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
