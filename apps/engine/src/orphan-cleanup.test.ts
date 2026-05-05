import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { cleanupOrphanFfmpegs, defaultKill } from "./orphan-cleanup.ts";

/**
 * Tests use a fake /proc directory rooted in a tmpdir. Each test
 * builds the /proc/<pid>/cmdline entries it cares about, then runs
 * the cleanup with a fake `killImpl` so we don't touch real
 * processes.
 *
 * The fake kill simulates a process that dies on SIGTERM unless
 * `simulateIgnoreSigterm` includes the pid (in which case only
 * SIGKILL kills it).
 */

interface FakeKill {
  killImpl: (pid: number, signal: NodeJS.Signals | 0) => void;
  signals: { pid: number; signal: NodeJS.Signals | 0 }[];
  /** Pids that survive SIGTERM (only SIGKILL kills them). */
  ignoreSigterm: Set<number>;
  /** Pids that die naturally before any signal arrives. */
  alreadyDead: Set<number>;
}

function fakeKill(initialAlive: number[] = []): FakeKill {
  const alive = new Set<number>(initialAlive);
  const signals: { pid: number; signal: NodeJS.Signals | 0 }[] = [];
  const ignoreSigterm = new Set<number>();
  const alreadyDead = new Set<number>();

  const killImpl = (pid: number, signal: NodeJS.Signals | 0) => {
    signals.push({ pid, signal });
    if (alreadyDead.has(pid) || !alive.has(pid)) {
      const err: NodeJS.ErrnoException = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    }
    if (signal === 0) return; // existence probe; alive
    if (signal === "SIGKILL") {
      alive.delete(pid);
      return;
    }
    if (signal === "SIGTERM" && !ignoreSigterm.has(pid)) {
      alive.delete(pid);
      return;
    }
    // SIGTERM ignored: process keeps running
  };

  return { killImpl, signals, ignoreSigterm, alreadyDead };
}

const HLS_ROOT = "/dev/shm/1008/radio-hls";

describe("cleanupOrphanFfmpegs", () => {
  let proc: string;

  beforeEach(async () => {
    proc = await mkdtemp(path.join(tmpdir(), "pavoia-orphan-proc-"));
  });
  afterEach(async () => {
    await rm(proc, { recursive: true, force: true });
  });

  /** Write a fake /proc/<pid>/cmdline with NUL-separated argv. */
  async function writeCmdline(pid: number, ...argv: string[]): Promise<void> {
    const dir = path.join(proc, String(pid));
    await mkdir(dir);
    await writeFile(path.join(dir, "cmdline"), argv.join("\0"));
  }

  /** Make /proc/<pid>/ exist but cmdline unreadable (EACCES sim via missing file). */
  async function writeUnreadable(pid: number): Promise<void> {
    await mkdir(path.join(proc, String(pid)));
    // Don't write cmdline — readFile will ENOENT, which the scanner
    // tolerates the same way it tolerates EACCES.
  }

  it("returns {killed:0, attempted:0} when /proc has no matches", async () => {
    await writeCmdline(101, "/usr/bin/sleep", "60");
    await writeCmdline(102, "/usr/bin/bash", "-c", "echo hi");
    const fake = fakeKill();
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
    assert.equal(fake.signals.length, 0);
  });

  it("kills ffmpeg processes whose cmdline references hlsRoot", async () => {
    await writeCmdline(
      201,
      "/usr/bin/ffmpeg",
      "-i",
      "/path/to/track.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    await writeCmdline(
      202,
      "/usr/bin/ffmpeg",
      "-i",
      "/path/to/other.mp3",
      "/dev/shm/1008/radio-hls/closing/index.m3u8",
    );
    const fake = fakeKill([201, 202]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 2);
    assert.equal(result.killed, 2);
    const sigterms = fake.signals
      .filter((s) => s.signal === "SIGTERM")
      .map((s) => s.pid)
      .sort((a, b) => a - b);
    assert.deepEqual(sigterms, [201, 202]);
  });

  it("does not match ffmpeg processes that don't reference hlsRoot", async () => {
    // Other tenant's ffmpeg, jellyfin's ffmpeg, etc.
    await writeCmdline(
      301,
      "/usr/bin/ffmpeg",
      "-i",
      "/home/other-user/media/movie.mkv",
      "out.mp4",
    );
    const fake = fakeKill([301]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
    assert.equal(fake.signals.length, 0);
  });

  it("does not match non-ffmpeg processes that mention hlsRoot", async () => {
    // e.g. an `ls` we ran during debugging, or a `tail` on the m3u8.
    await writeCmdline(
      401,
      "/usr/bin/ls",
      "/dev/shm/1008/radio-hls/opening/",
    );
    await writeCmdline(
      402,
      "/usr/bin/cat",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([401, 402]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
    assert.equal(fake.signals.length, 0);
  });

  it("matches when argv[0] is the bare basename 'ffmpeg' (no path)", async () => {
    // ffmpeg invoked via PATH with no leading directory.
    await writeCmdline(
      501,
      "ffmpeg",
      "-i",
      "/path/in.mp3",
      "/dev/shm/1008/radio-hls/etage-0/index.m3u8",
    );
    const fake = fakeKill([501]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
  });

  it("escalates to SIGKILL after termWaitMs when SIGTERM is ignored", async () => {
    await writeCmdline(
      601,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([601]);
    fake.ignoreSigterm.add(601);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      termWaitMs: 50,
      delayMs: async (ms) => {
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
    const seen = fake.signals.map((s) => s.signal);
    assert.ok(seen.includes("SIGTERM"), "expected SIGTERM");
    assert.ok(seen.includes("SIGKILL"), "expected SIGKILL escalation");
  });

  it("tolerates a pid that exits between scan and SIGTERM (ESRCH)", async () => {
    await writeCmdline(
      701,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    // Process is "already dead" by the time we try to signal it.
    const fake = fakeKill([]); // not in the alive set
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 1);
    // Counted as killed (it's dead — that's all we needed).
    assert.equal(result.killed, 1);
  });

  it("tolerates /proc/<pid>/cmdline that vanishes mid-scan (race)", async () => {
    // Directory exists but no cmdline file — simulates the process
    // exiting between readdir and readFile, OR EACCES on a shared
    // host with hidepid mounted.
    await writeUnreadable(801);
    await writeCmdline(
      802,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([802]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    // 801 was skipped (unreadable); 802 was reaped.
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
  });

  it("ignores empty cmdline (kernel threads, just-died zombies)", async () => {
    const dir = path.join(proc, "901");
    await mkdir(dir);
    await writeFile(path.join(dir, "cmdline"), Buffer.alloc(0));
    const fake = fakeKill();
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
  });

  it("ignores non-numeric /proc entries (e.g. /proc/cpuinfo, /proc/self)", async () => {
    await mkdir(path.join(proc, "self"));
    await writeFile(path.join(proc, "cpuinfo"), "");
    await writeFile(path.join(proc, "meminfo"), "");
    const fake = fakeKill();
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
  });

  it("skips own pid (does not kill the engine itself)", async () => {
    await writeCmdline(
      process.pid,
      "/usr/bin/ffmpeg", // hypothetical; the real engine isn't ffmpeg
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([process.pid]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
    assert.equal(
      fake.signals.length,
      0,
      "must never signal own pid",
    );
  });

  it("returns {killed:0, attempted:0} when /proc itself is unreadable (no throw)", async () => {
    const fake = fakeKill();
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: path.join(proc, "does-not-exist"),
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
  });

  it("logs match count and reap result when orphans are found", async () => {
    await writeCmdline(
      1001,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([1001]);
    const lines: string[] = [];
    await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
      log: (line) => lines.push(line),
    });
    assert.ok(
      lines.some((l) => l.includes("found 1 ffmpeg")),
      "expected match-count log line",
    );
    assert.ok(
      lines.some((l) => l.includes("reaped 1 of 1")),
      "expected reap-summary log line",
    );
  });

  it("does not log on the no-match no-op path (clean startup)", async () => {
    const fake = fakeKill();
    const lines: string[] = [];
    await cleanupOrphanFfmpegs({
      hlsRoot: HLS_ROOT,
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
      log: (line) => lines.push(line),
    });
    assert.deepEqual(lines, [], "clean start should be silent");
  });

  it("matches a different hlsRoot when configured (no hard-coded path)", async () => {
    await writeCmdline(
      1101,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/var/cache/myradio/opening/index.m3u8",
    );
    const fake = fakeKill([1101]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: "/var/cache/myradio",
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
  });

  it("rejects a sibling path that shares hlsRoot's prefix but is not under it", async () => {
    // Path-prefix matching: hlsRoot is treated as a directory
    // boundary. /dev/shm/1008/radio-hls-DECOY/* must NOT match
    // hlsRoot=/dev/shm/1008/radio-hls — the old substring-include
    // matcher would have falsely reaped this.
    await writeCmdline(
      1201,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls-DECOY/opening/index.m3u8",
    );
    const fake = fakeKill([1201]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: "/dev/shm/1008/radio-hls",
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
  });

  it("rejects a path that has hlsRoot as a non-prefix substring", async () => {
    // /home/yolan/backups/dev/shm/1008/radio-hls/... contains the
    // hlsRoot path but not at the start. The old substring matcher
    // would have falsely matched; the new path-prefix matcher does
    // not.
    await writeCmdline(
      1301,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/home/yolan/backups/dev/shm/1008/radio-hls/copy.ts",
    );
    const fake = fakeKill([1301]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: "/dev/shm/1008/radio-hls",
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.deepEqual(result, { killed: 0, attempted: 0 });
  });

  it("matches when an arg is exactly hlsRoot (no children)", async () => {
    await writeCmdline(
      1401,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls",
    );
    const fake = fakeKill([1401]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: "/dev/shm/1008/radio-hls",
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
  });

  it("tolerates a trailing slash in the configured hlsRoot", async () => {
    // Operators may write HLS_ROOT with or without a trailing slash;
    // the matcher must canonicalize either way.
    await writeCmdline(
      1501,
      "/usr/bin/ffmpeg",
      "-i",
      "in.mp3",
      "/dev/shm/1008/radio-hls/opening/index.m3u8",
    );
    const fake = fakeKill([1501]);
    const result = await cleanupOrphanFfmpegs({
      hlsRoot: "/dev/shm/1008/radio-hls/", // trailing slash
      procRoot: proc,
      killImpl: fake.killImpl,
      delayMs: async () => {},
    });
    assert.equal(result.attempted, 1);
    assert.equal(result.killed, 1);
  });
});

/**
 * The unit tests above use a fake killImpl that throws ESRCH on dead
 * pids. The PRODUCTION defaultKill must do the same on signal 0 (the
 * existence probe used by isAlive) — otherwise isAlive always returns
 * true and the SIGTERM grace period collapses to "always SIGKILL".
 *
 * CodeRabbit caught this on the original PR (#21): the original
 * defaultKill swallowed ESRCH unconditionally, masking real death from
 * the existence probe. This block asserts the contract directly and
 * runs a real-process integration test so a regression couldn't slip
 * past the unit tests' fake killImpl.
 */
describe("defaultKill — ESRCH propagation contract", () => {
  /** Spawn /bin/true and resolve with its (now-dead) pid once exited. */
  function spawnAndAwaitExit(): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/true", [], { stdio: "ignore" });
      const pid = child.pid;
      if (pid === undefined) {
        reject(new Error("spawn /bin/true failed: no pid"));
        return;
      }
      child.on("error", reject);
      child.on("exit", () => {
        // Give the kernel a moment to clear the pid from /proc so a
        // subsequent kill(pid, 0) sees ESRCH cleanly. This is paranoid
        // — exit handlers usually fire after the kernel has reaped —
        // but the test is timing-sensitive enough to warrant the wait.
        setTimeout(() => resolve(pid), 50);
      });
    });
  }

  it("throws ESRCH on signal 0 for a dead pid (so isAlive can detect death)", async () => {
    const deadPid = await spawnAndAwaitExit();
    assert.throws(
      () => defaultKill(deadPid, 0),
      (err: NodeJS.ErrnoException) => err.code === "ESRCH",
    );
  });

  it("swallows ESRCH on SIGTERM for a dead pid (already-dead == success)", async () => {
    const deadPid = await spawnAndAwaitExit();
    assert.doesNotThrow(() => defaultKill(deadPid, "SIGTERM"));
  });

  it("swallows ESRCH on SIGKILL for a dead pid (already-dead == success)", async () => {
    const deadPid = await spawnAndAwaitExit();
    assert.doesNotThrow(() => defaultKill(deadPid, "SIGKILL"));
  });

  it("does not throw on signal 0 for an alive pid (own process)", () => {
    assert.doesNotThrow(() => defaultKill(process.pid, 0));
  });
});

describe("cleanupOrphanFfmpegs — real /proc + real defaultKill (integration)", () => {
  /**
   * Spawn a real /bin/sh that pretends to be ffmpeg via Node's argv0
   * option. The sh process loops forever on `read -t` so it stays
   * alive in /proc with our hlsRoot marker visible in cmdline, and
   * dies cleanly on SIGTERM (sh interrupts the read).
   */
  function spawnFakeFfmpeg(hlsRoot: string): {
    pid: number;
    waitForExit: Promise<void>;
    forceKill: () => void;
  } {
    const child = spawn(
      "/bin/bash",
      [
        "-c",
        // Multi-statement loop body so bash CAN'T tail-exec the
        // sleep (which would replace bash's argv with sleep's, hiding
        // our hlsRoot marker from /proc/<pid>/cmdline).
        "while :; do sleep 1; done",
        // bash's $0 — visible in cmdline:
        "fake-ffmpeg-driver",
        // bash's $1 — also visible in cmdline, contains hlsRoot marker:
        `${hlsRoot}/opening/index.m3u8`,
      ],
      {
        stdio: "ignore",
        // argv0 puts "ffmpeg" as argv[0] in /proc/<pid>/cmdline so
        // the basename matcher inside cleanupOrphanFfmpegs accepts it.
        argv0: "ffmpeg",
        detached: false,
      },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("spawn failed");
    const waitForExit = new Promise<void>((resolve) => {
      child.on("exit", () => resolve());
    });
    return {
      pid,
      waitForExit,
      forceKill: () => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
      },
    };
  }

  it("reaps a real pid via real /proc + real defaultKill", async () => {
    // Unique hlsRoot so we can't possibly collide with another test
    // run, another tenant on a shared CI host, or our actual engine.
    const hlsRoot = `/tmp/pavoia-orphan-itest-${process.pid}-${Date.now()}`;
    const child = spawnFakeFfmpeg(hlsRoot);
    try {
      // Give the kernel a moment to populate /proc/<pid>/cmdline.
      await new Promise((r) => setTimeout(r, 200));

      const result = await cleanupOrphanFfmpegs({
        hlsRoot,
        // Default termWaitMs (2 s) plus the test runner's tolerance.
        log: () => {},
      });

      // We may catch sibling sh processes from the test runner
      // itself spawning helpers, but our fake-ffmpeg should be among
      // them, and all matched processes should be killed.
      assert.ok(
        result.attempted >= 1,
        `expected ≥1 match for hlsRoot=${hlsRoot}; got ${result.attempted}`,
      );
      assert.equal(
        result.killed,
        result.attempted,
        "every matched pid should be killed",
      );

      // Wait for the child to actually exit so the test cleanly
      // closes its handle.
      await Promise.race([
        child.waitForExit,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("child did not exit")), 5000),
        ),
      ]);
    } finally {
      child.forceKill();
    }
  });
});
