import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareStageDir, cleanStageDir } from "./hls-dir.ts";

describe("prepareStageDir", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-hlsdir-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("creates a nested directory (recursive mkdir)", async () => {
    const target = path.join(work, "a/b/c");
    await prepareStageDir(target);
    const st = await stat(target);
    assert.ok(st.isDirectory());
  });

  it("is idempotent on an existing directory", async () => {
    const target = path.join(work, "x");
    await prepareStageDir(target);
    await prepareStageDir(target); // must not throw EEXIST
  });
});

describe("cleanStageDir", () => {
  let work: string;
  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-hlsclean-"));
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("returns 0 for a nonexistent directory (no error)", async () => {
    const n = await cleanStageDir(path.join(work, "does-not-exist"));
    assert.equal(n, 0);
  });

  it("returns 0 for an empty existing directory", async () => {
    await mkdir(path.join(work, "empty"));
    const n = await cleanStageDir(path.join(work, "empty"));
    assert.equal(n, 0);
  });

  it("removes index.m3u8 and all seg-*.ts files, returns count", async () => {
    const d = path.join(work, "stage");
    await mkdir(d);
    await writeFile(path.join(d, "index.m3u8"), "#EXTM3U\n");
    await writeFile(path.join(d, "seg-00000.ts"), "a");
    await writeFile(path.join(d, "seg-00001.ts"), "b");
    await writeFile(path.join(d, "seg-12345.ts"), "c");
    const n = await cleanStageDir(d);
    assert.equal(n, 4);
    const remaining = await readdir(d);
    assert.deepEqual(remaining, []);
  });

  it("preserves non-HLS files (curating.aac, README, etc.)", async () => {
    const d = path.join(work, "stage");
    await mkdir(d);
    await writeFile(path.join(d, "curating.aac"), "x");
    await writeFile(path.join(d, "README"), "y");
    await writeFile(path.join(d, "seg-00000.ts"), "z");
    const n = await cleanStageDir(d);
    assert.equal(n, 1);
    const remaining = (await readdir(d)).sort();
    assert.deepEqual(remaining, ["README", "curating.aac"]);
  });

  it("does not touch similarly-named files that don't match the HLS pattern", async () => {
    const d = path.join(work, "stage");
    await mkdir(d);
    // Near-misses that must NOT be deleted.
    await writeFile(path.join(d, "seg-.ts"), "");
    await writeFile(path.join(d, "seg-abc.ts"), "");
    await writeFile(path.join(d, "index.m3u8.bak"), "");
    await writeFile(path.join(d, "prefix-seg-00000.ts"), "");
    const n = await cleanStageDir(d);
    assert.equal(n, 0);
  });
});
