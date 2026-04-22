import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { runTrack } from "./runner.ts";

/**
 * These tests use `node -e "<script>"` as a fake ffmpeg. That lets us
 * simulate arbitrary exit codes, signal handlers, and stderr patterns
 * portably without shipping shell scripts. process.execPath is always
 * available (we're IN node).
 */
const FAKE_FFMPEG = process.execPath;

describe("runTrack", () => {
  it("resolves { kind: 'ok' } on exit 0", async () => {
    const ac = new AbortController();
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", "process.exit(0)"],
      signal: ac.signal,
    });
    assert.deepEqual(result, { kind: "ok" });
  });

  it("resolves { kind: 'crashed', code } on non-zero exit", async () => {
    const ac = new AbortController();
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", "process.exit(42)"],
      signal: ac.signal,
    });
    assert.deepEqual(result, { kind: "crashed", code: 42, signal: null });
  });

  it("resolves { kind: 'aborted' } when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", "process.exit(0)"],
      signal: ac.signal,
    });
    assert.deepEqual(result, { kind: "aborted" });
  });

  it("resolves { kind: 'aborted' } when the signal aborts mid-run (SIGTERM cooperates)", async () => {
    const ac = new AbortController();
    const script = `
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => process.exit(143));
    `;
    const p = runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      killTimeoutMs: 5000,
    });
    setTimeout(() => ac.abort(), 50);
    const result = await p;
    assert.deepEqual(result, { kind: "aborted" });
  });

  it("escalates to SIGKILL if the child ignores SIGTERM", async () => {
    const ac = new AbortController();
    const script = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const start = Date.now();
    const p = runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      killTimeoutMs: 150,
    });
    setTimeout(() => ac.abort(), 20);
    const result = await p;
    assert.deepEqual(result, { kind: "aborted" });
    // SIGKILL escalation must have happened within a reasonable window —
    // guards against a regression where the kill timer doesn't fire.
    // Generous upper bound (2s) to absorb CI scheduler jitter. The
    // invariant we care about is that SIGKILL fires within a reasonable
    // window of killTimeoutMs=150 — orders of magnitude below 2s is
    // plenty of slack. Anything larger would mean the kill timer
    // didn't fire at all.
    assert.ok(
      Date.now() - start < 2000,
      `took ${Date.now() - start}ms; SIGKILL timer likely did not fire`,
    );
  });

  it("delivers every stderr line when many lines are written then the child exits naturally", async () => {
    // Regression: exercises the race between the child 'close' event
    // and readline's buffered 'line' emission. The runner must gate
    // resolution on BOTH events. If it resolved on 'close' alone,
    // lines that were buffered in readline but not yet emitted as
    // 'line' events would be lost.
    //
    // NOTE: process.exit() in the child SKIPS stdio flush, so we use a
    // natural exit (letting the write callback complete) to isolate
    // the runner's race from Node's exit-flushing behavior. The race
    // we care about is on the PARENT (runner) side: given the data
    // reached the pipe, did the runner wait for readline to surface
    // it? That is what this test verifies.
    const ac = new AbortController();
    const lines: string[] = [];
    const N = 200;
    const script = `
      let pending = ${N};
      for (let i = 0; i < ${N}; i++) {
        process.stderr.write('line' + i + '\\n', () => {
          if (--pending === 0) process.exit(0);
        });
      }
    `;
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      onStderrLine: (l) => lines.push(l),
    });
    assert.deepEqual(result, { kind: "ok" });
    assert.equal(lines.length, N, `got ${lines.length}/${N} lines`);
    for (let i = 0; i < N; i++) {
      assert.equal(lines[i], `line${i}`, `line ${i} mismatch`);
    }
  });

  it("drains all stderr before resolving — no race between child close and readline close", async () => {
    // Regression: even after switching to 'close' (from 'exit'),
    // readline can still have buffered 'line' events in-flight when
    // the child's 'close' fires. The runner must also gate on
    // readline's 'close' event before settling. Written as a tight
    // write-then-exit sequence that uses the write callback to make
    // sure the byte actually flushed before the child exits.
    const ac = new AbortController();
    const lines: string[] = [];
    const script = `
      process.stderr.write("final diagnostic\\n", () => process.exit(1));
    `;
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      onStderrLine: (l) => lines.push(l),
    });
    assert.deepEqual(result, { kind: "crashed", code: 1, signal: null });
    assert.ok(
      lines.includes("final diagnostic"),
      `final stderr line must be captured; lines=${JSON.stringify(lines)}`,
    );
  });

  it("forwards stderr to onStderrLine, split on newlines", async () => {
    // Uses a write-callback to ensure the last chunk is flushed before
    // process.exit — otherwise process.exit can race the final write
    // and drop bytes, masking runner correctness behind a Node-exit
    // behavior that's unrelated to what this test is checking.
    const ac = new AbortController();
    const lines: string[] = [];
    const script = `
      process.stderr.write("line one\\n");
      process.stderr.write("line two\\nline three\\n", () => process.exit(0));
    `;
    await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      onStderrLine: (l) => lines.push(l),
    });
    assert.deepEqual(lines, ["line one", "line two", "line three"]);
  });

  it("never throws when onStderrLine itself throws", async () => {
    const ac = new AbortController();
    const script = `
      process.stderr.write("boom\\n");
      process.exit(0);
    `;
    const result = await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
      onStderrLine: () => {
        throw new Error("logger down");
      },
    });
    assert.deepEqual(result, { kind: "ok" });
  });

  it("resolves { kind: 'crashed' } when the binary is missing", async () => {
    const ac = new AbortController();
    const result = await runTrack({
      ffmpegBin: "/nonexistent/ffmpeg-xyz-does-not-exist-here",
      argv: [],
      signal: ac.signal,
    });
    assert.equal(result.kind, "crashed");
  });

  it("is safe to abort twice (idempotent)", async () => {
    const ac = new AbortController();
    const script = `
      setInterval(() => {}, 1000);
      process.on("SIGTERM", () => process.exit(0));
    `;
    const p = runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
    });
    setTimeout(() => {
      ac.abort();
      ac.abort(); // double abort should be harmless
    }, 30);
    const result = await p;
    // On Linux, SIGTERM handlers that call process.exit(0) yield an
    // exit-code=0 path — which runTrack classifies by caller intent:
    // since the caller aborted, the outcome is "aborted".
    assert.deepEqual(result, { kind: "aborted" });
  });

  it("does not add global process 'exit' listeners per run", async () => {
    // What this actually verifies: runTrack must not register listeners
    // on the global `process` object. If it did, looping the supervisor
    // over hundreds of tracks would eventually hit Node's
    // MaxListenersExceededWarning. The caller's own AbortSignal is a
    // separate concern — internal listener removal there is covered by
    // the "is safe to abort twice (idempotent)" test above (the second
    // abort being a no-op proves the listener was cleared on exit).
    const ac = new AbortController();
    const script = `process.exit(0);`;
    const before = process.listenerCount("exit");
    await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
    });
    const after = process.listenerCount("exit");
    assert.equal(
      after,
      before,
      "runTrack must not add listeners to the global process 'exit' event",
    );
  });
});
