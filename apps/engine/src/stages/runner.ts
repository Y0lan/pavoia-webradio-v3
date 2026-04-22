// Runs a single ffmpeg invocation to completion and reports the outcome.
//
// The thin seam between `buildFfmpegArgs()` and the supervisor — pure
// process lifecycle with no policy. One call == one spawn == one exit.
//
// Contract:
//   - spawn(ffmpegBin, argv) with stdin ignored (matches -nostdin).
//   - stderr is drained line-by-line to `onStderrLine` so slow consumers
//     don't backpressure ffmpeg.
//   - The returned promise resolves (never rejects) to one of:
//       { kind: "ok" }            — ffmpeg exited 0
//       { kind: "aborted" }       — caller aborted the AbortSignal
//       { kind: "crashed", ... }  — anything else (non-zero exit, signal
//                                   other than our SIGTERM, spawn error)
//   - When the caller aborts: SIGTERM immediately, then SIGKILL after
//     `killTimeoutMs` (default 5s) if the child hasn't exited. This is
//     important for Whatbox's cron watchdog redeploy pattern (Req E):
//     the engine must stop cleanly within the 5s SIGTERM window.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type TrackExit =
  | { kind: "ok" }
  | { kind: "aborted" }
  | { kind: "crashed"; code: number | null; signal: NodeJS.Signals | null };

export interface RunTrackInput {
  /** Absolute path or bare name resolved on PATH. Defaults to "ffmpeg". */
  ffmpegBin?: string;
  /** Full argv AFTER the binary. */
  argv: string[];
  /** Caller aborts this to request graceful stop. */
  signal: AbortSignal;
  /** Called once per stderr line (CR/LF stripped). Default: no-op. */
  onStderrLine?: (line: string) => void;
  /** Grace period between SIGTERM and SIGKILL. Default 5000 ms. */
  killTimeoutMs?: number;
}

export function runTrack(input: RunTrackInput): Promise<TrackExit> {
  const {
    ffmpegBin = "ffmpeg",
    argv,
    signal,
    onStderrLine = () => {},
    killTimeoutMs = 5000,
  } = input;

  if (signal.aborted) {
    return Promise.resolve<TrackExit>({ kind: "aborted" });
  }

  return new Promise<TrackExit>((resolve) => {
    const child = spawn(ffmpegBin, argv, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let settled = false;
    let abortedByCaller = false;
    let killTimer: NodeJS.Timeout | null = null;

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const onAbort = () => {
      if (abortedByCaller || settled) return;
      abortedByCaller = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, killTimeoutMs);
        killTimer.unref();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const settle = (outcome: TrackExit) => {
      if (settled) return;
      settled = true;
      clearKillTimer();
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };

    if (child.stderr) {
      // Prevent uncaught 'error' from a broken stderr pipe crashing the
      // process. ffmpeg's stderr rarely errors, but EPIPE is possible
      // if the child closes it asynchronously.
      child.stderr.on("error", () => {});
      const rl = createInterface({ input: child.stderr });
      rl.on("line", (line) => {
        try {
          onStderrLine(line);
        } catch {
          // Never let a logger failure propagate into ffmpeg's lifecycle.
        }
      });
      rl.on("error", () => {});
    }

    child.on("error", (err) => {
      // Spawn-level failure (binary missing, EACCES). 'exit' may or may
      // not follow depending on libuv; settle() guards against both.
      try {
        onStderrLine(
          `[runner] spawn error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        /* ignore */
      }
      settle({ kind: "crashed", code: null, signal: null });
    });

    child.on("exit", (code, sig) => {
      if (abortedByCaller) {
        settle({ kind: "aborted" });
      } else if (code === 0 && sig === null) {
        settle({ kind: "ok" });
      } else {
        settle({ kind: "crashed", code, signal: sig });
      }
    });
  });
}
