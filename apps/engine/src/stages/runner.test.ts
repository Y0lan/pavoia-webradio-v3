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
    assert.ok(
      Date.now() - start < 1000,
      `took ${Date.now() - start}ms; SIGKILL timer likely did not fire`,
    );
  });

  it("drains all stderr before resolving — no race between exit and readline close", async () => {
    // Regression: Node can emit 'exit' before readline has delivered
    // its last stderr 'line' event. Listening on 'close' (not 'exit')
    // is what guarantees the logger gets the final diagnostic lines.
    // If the fix regresses, this test sometimes reports 0 lines.
    const ac = new AbortController();
    const lines: string[] = [];
    const script = `
      process.stderr.write("final diagnostic\\n");
      process.exit(1);
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
    const ac = new AbortController();
    const lines: string[] = [];
    const script = `
      process.stderr.write("line one\\n");
      process.stderr.write("line two\\nline three\\n");
      process.exit(0);
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

  it("leaves no child behind after the promise resolves", async () => {
    const ac = new AbortController();
    const script = `process.exit(0);`;
    const before = process.listenerCount("exit");
    await runTrack({
      ffmpegBin: FAKE_FFMPEG,
      argv: ["-e", script],
      signal: ac.signal,
    });
    const after = process.listenerCount("exit");
    assert.equal(after, before, "runTrack must not leak process 'exit' listeners");
  });
});
