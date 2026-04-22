import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { waitForFirstSegment } from "./watchers.ts";

describe("waitForFirstSegment", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-watcher-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("returns 'ready' as soon as the first seg-*.ts appears", async () => {
    const hlsDir = path.join(work, "hls");
    await mkdir(hlsDir);
    const ac = new AbortController();

    const p = waitForFirstSegment({
      hlsDir,
      signal: ac.signal,
      timeoutMs: 3000,
      pollIntervalMs: 50,
    });
    // Write a segment ~120 ms after the watcher starts — well within
    // the budget, but after at least one poll cycle.
    setTimeout(() => {
      void writeFile(path.join(hlsDir, "seg-00000.ts"), "x");
    }, 120);
    assert.equal(await p, "ready");
  });

  it("returns 'timeout' if no segment appears within the budget", async () => {
    const hlsDir = path.join(work, "hls");
    await mkdir(hlsDir);
    const ac = new AbortController();

    const r = await waitForFirstSegment({
      hlsDir,
      signal: ac.signal,
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    assert.equal(r, "timeout");
  });

  it("tolerates a missing directory (returns timeout, not throw)", async () => {
    const ac = new AbortController();
    const r = await waitForFirstSegment({
      hlsDir: path.join(work, "does-not-exist"),
      signal: ac.signal,
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    assert.equal(r, "timeout");
  });

  it("returns 'aborted' immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await waitForFirstSegment({
      hlsDir: path.join(work, "hls"),
      signal: ac.signal,
      timeoutMs: 5000,
      pollIntervalMs: 50,
    });
    assert.equal(r, "aborted");
  });

  it("returns 'aborted' fast when the signal aborts mid-wait", async () => {
    const hlsDir = path.join(work, "hls");
    await mkdir(hlsDir);
    const ac = new AbortController();
    const start = Date.now();
    const p = waitForFirstSegment({
      hlsDir,
      signal: ac.signal,
      timeoutMs: 5000,
      pollIntervalMs: 50,
    });
    setTimeout(() => ac.abort(), 60);
    const r = await p;
    assert.equal(r, "aborted");
    // Must exit within a poll interval of the abort, not after the full
    // 5s timeout.
    assert.ok(
      Date.now() - start < 500,
      `abort was not prompt; took ${Date.now() - start}ms`,
    );
  });

  it("ignores non-matching files (partial segments, m3u8, etc.)", async () => {
    const hlsDir = path.join(work, "hls");
    await mkdir(hlsDir);
    // Pre-seed the dir with near-miss names that must NOT satisfy.
    await writeFile(path.join(hlsDir, "seg-abc.ts"), "x");
    await writeFile(path.join(hlsDir, "index.m3u8"), "#EXTM3U\n");
    await writeFile(path.join(hlsDir, "seg-.ts"), "x");

    const ac = new AbortController();
    const r = await waitForFirstSegment({
      hlsDir,
      signal: ac.signal,
      timeoutMs: 200,
      pollIntervalMs: 50,
    });
    assert.equal(r, "timeout");
  });
});
