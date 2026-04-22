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
    let childClosed = false;
    let readlineClosed = false;
    let pendingExit: {
      code: number | null;
      sig: NodeJS.Signals | null;
    } | null = null;

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

    // Settle only after BOTH the child process has closed AND the
    // readline interface has flushed its buffered 'line' events. On
    // Node 25 the child 'close' event can race with readline's internal
    // line buffering — if we resolved on 'close' alone, a tightly
    // written "last diagnostic line + exit" sequence from ffmpeg can
    // drop the final line. Gating on readline's own 'close' (which
    // fires AFTER readline has emitted every line it buffered from the
    // now-ended input stream) makes stderr delivery ordered w.r.t.
    // resolution.
    const tryFinish = () => {
      if (settled || !childClosed || !readlineClosed || !pendingExit) return;
      const { code, sig } = pendingExit;
      if (abortedByCaller) {
        settle({ kind: "aborted" });
      } else if (code === 0 && sig === null) {
        settle({ kind: "ok" });
      } else {
        settle({ kind: "crashed", code, signal: sig });
      }
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
      rl.on("close", () => {
        readlineClosed = true;
        tryFinish();
      });
    } else {
      // No stderr to drain (shouldn't happen under our stdio config).
      readlineClosed = true;
    }

    child.on("error", (err) => {
      // Spawn-level failure (binary missing, EACCES). 'close' still
      // follows per Node docs; settle() below guards against the double
      // fire. On spawn failure we resolve immediately — there's no
      // meaningful stderr to wait for.
      try {
        onStderrLine(
          `[runner] spawn error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } catch {
        /* ignore */
      }
      settle({ kind: "crashed", code: null, signal: null });
    });

    child.on("close", (code, sig) => {
      childClosed = true;
      pendingExit = { code, sig };
      tryFinish();
    });
  });
}
