import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { preflightTrack } from "./preflight.ts";

describe("preflightTrack", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-preflight-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("returns ok + size for a regular file above the min threshold", async () => {
    const p = path.join(work, "track.opus");
    // 2 KiB of bytes — comfortably above the 1 KiB floor.
    await writeFile(p, Buffer.alloc(2048, 0x42));
    const r = await preflightTrack(p);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.sizeBytes, 2048);
  });

  it("returns reason='missing' for a nonexistent path", async () => {
    const r = await preflightTrack(path.join(work, "nope.opus"));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "missing");
  });

  it("returns reason='missing' for a dangling symlink", async () => {
    const target = path.join(work, "gone.opus");
    const link = path.join(work, "link.opus");
    await writeFile(target, Buffer.alloc(2048));
    await symlink(target, link);
    await rm(target);
    const r = await preflightTrack(link);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "missing");
  });

  it("returns reason='not_a_regular_file' for a directory", async () => {
    const d = path.join(work, "subdir");
    await mkdir(d);
    const r = await preflightTrack(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "not_a_regular_file");
  });

  it("returns reason='empty' for a zero-byte file", async () => {
    const p = path.join(work, "empty.opus");
    await writeFile(p, "");
    const r = await preflightTrack(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "empty");
  });

  it("returns reason='too_small' for a file just below the min size", async () => {
    const p = path.join(work, "tiny.opus");
    await writeFile(p, Buffer.alloc(512, 0x00)); // 512 B, below 1 KiB
    const r = await preflightTrack(p);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "too_small");
  });

  it("returns reason='stat_error' for a permission denial (EACCES)", async () => {
    if (process.getuid?.() === 0) return; // running as root → can read anything
    const d = path.join(work, "locked");
    await mkdir(d, { mode: 0o000 });
    try {
      const r = await preflightTrack(path.join(d, "track.opus"));
      assert.equal(r.ok, false);
      if (!r.ok) {
        // ENOENT would also be a valid answer here on some kernels;
        // we care that it's a structured failure, not a crash.
        assert.ok(
          r.reason === "stat_error" || r.reason === "missing",
          `got ${r.reason}`,
        );
      }
    } finally {
      // Restore perms so the afterEach cleanup can rm the tree.
      const { chmod } = await import("node:fs/promises");
      await chmod(d, 0o700).catch(() => {});
    }
  });
});
