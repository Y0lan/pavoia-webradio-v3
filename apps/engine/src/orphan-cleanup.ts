// Reaps orphan ffmpeg processes left over from a previous engine run.
//
// On crash recovery (kill -9, OOM, kernel panic, watchdog respawn after
// HTTP 000), the previous engine's ffmpeg children are NOT taken down
// with it — Linux makes them orphans (PPID=1) and they keep writing
// HLS segments until they hit a broken pipe or finish their input.
// During that window:
//
//   - the new engine's cleanStageDir runs and removes index.m3u8 +
//     seg-*.ts, but the old ffmpegs immediately rewrite them
//   - the new ffmpegs spawn with `+append_list`, read the leftover
//     m3u8, and continue the segment counter (e.g. start at 4060+
//     instead of 0)
//   - listeners get a brief audio glitch and the dirs accumulate
//     orphan segments that never get cleaned
//
// Verified live on Whatbox during Task 7 smoke-test (2026-05-05): a
// kill -9 of the engine left 5 of 10 stages with leftover seg-04xxx
// files written by orphan ffmpegs over ~3 minutes after engine death.
//
// Whatbox doesn't have setpriv(1) so we can't use --pdeathsig SIGKILL
// at spawn time (the kernel-level fix). Instead, we reap on engine
// start: scan /proc, match any ffmpeg cmdline that mentions our
// HLS_ROOT, SIGTERM then SIGKILL.
//
// Called once at bootstrap, BEFORE any new supervisor starts.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface CleanupOptions {
  /** HLS output root (config.hlsRoot). An ffmpeg process is treated
   *  as one of ours iff its cmdline references this path. */
  hlsRoot: string;
  /** Optional logger; defaults to no-op. */
  log?: (line: string) => void;
  /** How long to wait between SIGTERM and SIGKILL escalation. */
  termWaitMs?: number;
  // === injection points for tests; defaults are the real /proc + kernel ===
  /** Defaults to "/proc". */
  procRoot?: string;
  /** Defaults to a wrapper around process.kill that swallows ESRCH. */
  killImpl?: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** Defaults to setTimeout-based delay. */
  delayMs?: (ms: number) => Promise<void>;
}

export interface CleanupResult {
  /** Number of matched ffmpeg processes that ended up dead by the
   *  time this function returned (whether via our SIGTERM, our
   *  SIGKILL, or natural death between scan and signal). */
  killed: number;
  /** Number of matched processes (orphans we attempted to reap). */
  attempted: number;
}

const FFMPEG_BASENAMES = new Set(["ffmpeg"]);
const PROC_PID_PATTERN = /^\d+$/;

/** Wraps process.kill so ESRCH (process already gone) is not thrown. */
function defaultKill(pid: number, signal: NodeJS.Signals | 0): void {
  try {
    process.kill(pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    throw err;
  }
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true iff `pid` is currently alive. Uses signal 0 (the
 * standard Unix existence probe). Treats ESRCH as dead and any other
 * error as alive (conservative — we'd rather try a SIGKILL than
 * silently skip).
 */
function isAlive(
  pid: number,
  killImpl: (pid: number, signal: NodeJS.Signals | 0) => void,
): boolean {
  try {
    killImpl(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

/**
 * Scan procRoot for processes whose cmdline says they're an ffmpeg
 * referencing hlsRoot. Returns the list of matched pids.
 *
 * Skips:
 *   - non-numeric /proc entries (kernel virtual files)
 *   - the current process pid (self)
 *   - cmdline read errors (process exited, EACCES on shared hosts)
 *   - empty cmdline (kernel threads, just-died zombies)
 *   - non-ffmpeg argv[0]
 *   - cmdlines that don't mention hlsRoot
 */
async function scanForOrphans(
  procRoot: string,
  hlsRoot: string,
): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(procRoot);
  } catch {
    // /proc unreadable — abort scan (returns empty so cleanup is a
    // no-op rather than a fatal error).
    return [];
  }

  const matches: number[] = [];
  const ownPid = process.pid;

  for (const entry of entries) {
    if (!PROC_PID_PATTERN.test(entry)) continue;
    const pid = Number(entry);
    if (pid === ownPid) continue;

    let raw: Buffer;
    try {
      raw = await readFile(path.join(procRoot, entry, "cmdline"));
    } catch {
      // Process exited between readdir and readFile (race), or
      // we don't have permission (EACCES on shared hosts under a
      // hidepid mount). Skip — not our concern.
      continue;
    }
    if (raw.length === 0) continue;

    // /proc/<pid>/cmdline is the process argv joined by NUL bytes.
    // The buffer may end with a trailing NUL (some kernels) or not.
    // Filter empty splits to handle either case.
    const argv = raw
      .toString("utf8")
      .split("\0")
      .filter((s) => s.length > 0);
    const [argv0] = argv;
    if (argv0 === undefined) continue;

    const argv0Basename = path.basename(argv0);
    if (!FFMPEG_BASENAMES.has(argv0Basename)) continue;

    if (argv.some((arg) => arg.includes(hlsRoot))) {
      matches.push(pid);
    }
  }

  return matches;
}

/**
 * Reap any orphan ffmpeg processes left over from a previous engine
 * run. Returns counts; never throws (a /proc scan failure or a kill
 * permission error is logged and treated as no-op).
 */
export async function cleanupOrphanFfmpegs(
  opts: CleanupOptions,
): Promise<CleanupResult> {
  const {
    hlsRoot,
    log = () => {},
    termWaitMs = 2000,
    procRoot = "/proc",
    killImpl = defaultKill,
    delayMs = defaultDelay,
  } = opts;

  const matches = await scanForOrphans(procRoot, hlsRoot);
  if (matches.length === 0) {
    return { killed: 0, attempted: 0 };
  }

  log(
    `[orphan-cleanup] found ${matches.length} ffmpeg process(es) referencing ${hlsRoot}; sending SIGTERM`,
  );

  for (const pid of matches) {
    try {
      killImpl(pid, "SIGTERM");
    } catch (err) {
      // Permission denied (other user) or some kernel-level error.
      // Log + continue; the SIGKILL pass below will retry.
      log(
        `[orphan-cleanup] SIGTERM pid=${pid} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Poll until all are dead OR termWaitMs elapses. 100ms granularity
  // keeps the hot path tight on the common case where SIGTERM reaps
  // them in <1s.
  const POLL_MS = 100;
  const deadline = Date.now() + termWaitMs;
  while (Date.now() < deadline) {
    if (matches.every((pid) => !isAlive(pid, killImpl))) break;
    await delayMs(POLL_MS);
  }

  // SIGKILL stragglers. Anything still alive after termWaitMs is
  // ignoring SIGTERM.
  let killed = 0;
  for (const pid of matches) {
    if (isAlive(pid, killImpl)) {
      try {
        killImpl(pid, "SIGKILL");
        killed++;
      } catch (err) {
        log(
          `[orphan-cleanup] SIGKILL pid=${pid} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // Already dead (SIGTERM landed cleanly, or natural death).
      killed++;
    }
  }

  log(`[orphan-cleanup] reaped ${killed} of ${matches.length}`);
  return { killed, attempted: matches.length };
}
