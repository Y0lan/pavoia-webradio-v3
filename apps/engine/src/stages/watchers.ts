// Polls a stage's HLS directory for the first seg-*.ts file to appear.
//
// Used by the supervisor for two overlapping concerns (both Codex
// challenge findings on Week 1 Task 3):
//
//   1. Watchdog: if ffmpeg spawns but produces no segment within a
//      bounded window, something is hung (unreadable file stalling
//      libav, kernel stall on tmpfs under pressure). The supervisor
//      treats that as a synthetic crash and moves on.
//
//   2. Honest now-playing: emit the `track_started` event only when
//      the track is actually producing audio. Emitting at spawn
//      time means `currentTrack()` / the WebSocket feed can claim
//      a track is playing when listeners still hear the previous
//      track's tail (or nothing, for a corrupt file).
//
// Abort-aware: a supervisor stop interrupts the poll without waiting
// for the timeout.

import { readdir } from "node:fs/promises";

const SEGMENT_PATTERN = /^seg-\d+\.ts$/;

export type WaitResult = "ready" | "timeout" | "aborted";

export interface WaitForFirstSegmentInput {
  hlsDir: string;
  signal: AbortSignal;
  /** Overall deadline in ms. Typical: 5000. */
  timeoutMs: number;
  /** How often we readdir. Default 200 ms — cheap on tmpfs, fast enough. */
  pollIntervalMs?: number;
}

export async function waitForFirstSegment(
  input: WaitForFirstSegmentInput,
): Promise<WaitResult> {
  const { hlsDir, signal, timeoutMs, pollIntervalMs = 200 } = input;
  if (signal.aborted) return "aborted";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (signal.aborted) return "aborted";
    try {
      const entries = await readdir(hlsDir);
      if (entries.some((e) => SEGMENT_PATTERN.test(e))) return "ready";
    } catch (err) {
      // ENOENT just means the supervisor hasn't mkdir'd it yet. Any
      // other stat error is transient; retry next poll.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        // swallow — watcher stays best-effort.
      }
    }
    const waited = await abortableSleep(
      pollIntervalMs,
      signal,
    );
    if (waited === "aborted") return "aborted";
  }
  return "timeout";
}

async function abortableSleep(
  ms: number,
  signal: AbortSignal,
): Promise<"slept" | "aborted"> {
  if (signal.aborted) return "aborted";
  return new Promise<"slept" | "aborted">((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
