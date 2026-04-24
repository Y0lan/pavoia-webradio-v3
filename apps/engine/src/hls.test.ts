import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";

import { createHlsHandler } from "./hls.ts";
import { createStageRegistry } from "./stages/registry.ts";
import type { StageController } from "./stages/supervisor.ts";
import type { Stage } from "@pavoia/shared";

function fakeStage(
  id: string,
  disabled = false,
  plexPlaylistId: number | null = 100,
): Stage {
  return {
    id: id as Stage["id"],
    order: 0,
    plexPlaylistId,
    icon: "🎵",
    fallbackTitle: id,
    fallbackDescription: "",
    gradient: { from: "#000", via: "#000", to: "#000" },
    accent: "#fff",
    disabled,
  };
}

describe("createHlsHandler — happy path", () => {
  let work: string;
  let hlsRoot: string;
  let app: Hono;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-hls-handler-"));
    hlsRoot = path.join(work, "hls");
    await mkdir(path.join(hlsRoot, "opening"), { recursive: true });
    await writeFile(
      path.join(hlsRoot, "opening", "index.m3u8"),
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:3.000,\nseg-00000.ts\n",
    );
    await writeFile(
      path.join(hlsRoot, "opening", "seg-00000.ts"),
      Buffer.alloc(2048, 0xab),
    );
    const root = new Hono();
    root.route(
      "/hls",
      createHlsHandler({
        hlsRoot,
        catalog: [fakeStage("opening"), fakeStage("bus", true, null)],
      }),
    );
    app = root;
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("serves the m3u8 with HLS content-type and no-cache", async () => {
    const res = await app.request("/hls/opening/index.m3u8");
    assert.equal(res.status, 200);
    assert.equal(
      res.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.match(res.headers.get("cache-control") ?? "", /no-cache/);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    const body = await res.text();
    assert.match(body, /#EXTM3U/);
  });

  it("serves a segment with mp2t content-type and a SHORT max-age (NOT immutable)", async () => {
    // Regression: segments WERE marked immutable, which caused stale
    // audio after engine restarts (cleanStageDir + ffmpeg restarts
    // numbering at 00000, so the same URL maps to different bytes).
    const res = await app.request("/hls/opening/seg-00000.ts");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "video/mp2t");
    const cc = res.headers.get("cache-control") ?? "";
    assert.match(cc, /max-age=\d+/);
    assert.doesNotMatch(
      cc,
      /immutable/,
      "segments must not be immutable — URLs re-bind after restart",
    );
    assert.equal(res.headers.get("content-length"), "2048");
    const buf = new Uint8Array(await res.arrayBuffer());
    assert.equal(buf.length, 2048);
    assert.equal(buf[0], 0xab);
  });
});

describe("createHlsHandler — validation + safety", () => {
  let work: string;
  let hlsRoot: string;
  let app: Hono;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), "pavoia-hls-handler-"));
    hlsRoot = path.join(work, "hls");
    await mkdir(path.join(hlsRoot, "opening"), { recursive: true });
    await writeFile(
      path.join(hlsRoot, "opening", "index.m3u8"),
      "#EXTM3U\n",
    );
    const root = new Hono();
    root.route(
      "/hls",
      createHlsHandler({
        hlsRoot,
        catalog: [fakeStage("opening"), fakeStage("bus", true, null)],
      }),
    );
    app = root;
  });
  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it("returns 404 stage_not_found for a stage not in the catalog", async () => {
    const res = await app.request("/hls/no-such-stage/index.m3u8");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "stage_not_found");
    assert.equal(body.stageId, "no-such-stage");
  });

  it("returns 410 stage_has_no_audio for the disabled bus stage", async () => {
    const res = await app.request("/hls/bus/index.m3u8");
    assert.equal(res.status, 410);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "stage_has_no_audio");
  });

  it("returns 404 bad_filename for unexpected file names", async () => {
    for (const f of [
      "index.html",
      "seg-abc.ts",
      "seg-.ts",
      "config.json",
      ".env",
      "seg-00000.ts.bak",
    ]) {
      const res = await app.request(`/hls/opening/${f}`);
      assert.equal(res.status, 404, `${f} must be rejected`);
      const body = (await res.json()) as { error: string };
      assert.equal(body.error, "bad_filename", `${f} reason mismatch`);
    }
  });

  it("rejects path-traversal attempts in the URL", async () => {
    // Hono normalizes URL segments before they hit the route param,
    // so the engine sees no `..` ever — but the redundant guard
    // still rejects anything weird on the resolved-path side.
    for (const url of [
      "/hls/opening/%2E%2E%2Fother",
      "/hls/opening/.bashrc",
    ]) {
      const res = await app.request(url);
      // bad_filename or stage_not_found — either way NEVER 200, never
      // serves arbitrary content.
      assert.notEqual(res.status, 200, `${url} must not be served`);
    }
  });

  it("returns 404 file_not_found when the file is missing on disk", async () => {
    const res = await app.request("/hls/opening/seg-99999.ts");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "file_not_found");
  });

  it("returns 404 not_a_file when the path resolves to a directory", async () => {
    // Edge case: someone created a "seg-12345.ts" DIRECTORY (e.g.
    // by `mkdir` typo). The catalog + filename validation pass; the
    // stat check refuses to serve a directory as a segment.
    await mkdir(path.join(hlsRoot, "opening", "seg-12345.ts"));
    const res = await app.request("/hls/opening/seg-12345.ts");
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_a_file");
  });

  it("rejects a symlink even when it points to a regular file outside the stage dir", async () => {
    // Defense-in-depth: even though the operator owns hlsRoot, we
    // refuse to follow symlinks. lstat detects the link before stat
    // would silently follow it.
    const outside = path.join(work, "secret.txt");
    await writeFile(outside, "ssssh");
    const symlinkPath = path.join(hlsRoot, "opening", "seg-00007.ts");
    try {
      await symlink(outside, symlinkPath);
    } catch {
      return; // some FS don't support symlinks (rare); skip silently
    }
    const res = await app.request("/hls/opening/seg-00007.ts");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "symlink_rejected");
  });

  it("rejects requests when the stage DIRECTORY itself is a symlink (containment escape)", async () => {
    // Codex round-5 [P2]: realpath(fullPath) and realpath(stageDir)
    // both resolve through a symlinked stage dir, so a relative
    // check between them passes — but the served file is OUTSIDE
    // the configured hlsRoot. Fix: lstat stageDir AND verify
    // realpath(fullPath) is inside the configured hlsRoot.
    const evilDir = path.join(work, "outside");
    await mkdir(evilDir, { recursive: true });
    await writeFile(path.join(evilDir, "seg-00000.ts"), Buffer.alloc(2048));
    // Replace opening's stage dir with a symlink to the evil dir.
    await rm(path.join(hlsRoot, "opening"), { recursive: true });
    try {
      await symlink(evilDir, path.join(hlsRoot, "opening"));
    } catch {
      return; // FS doesn't support symlinks; skip
    }
    const res = await app.request("/hls/opening/seg-00000.ts");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    // Either symlink_rejected (lstat path) or path_traversal
    // (realpath containment path). Both are valid rejections.
    assert.ok(
      body.error === "symlink_rejected" || body.error === "path_traversal",
      `expected rejection; got ${body.error}`,
    );
  });

  it("rejects a symlink even when it points to a regular file INSIDE the stage dir", async () => {
    // The lstat check is unconditional — any symlink is refused, not
    // just outside-pointing ones. Keeps the policy unambiguous.
    const realFile = path.join(hlsRoot, "opening", "seg-00009.ts");
    await writeFile(realFile, Buffer.alloc(2048));
    const symlinkPath = path.join(hlsRoot, "opening", "seg-00010.ts");
    try {
      await symlink(realFile, symlinkPath);
    } catch {
      return;
    }
    const res = await app.request("/hls/opening/seg-00010.ts");
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "symlink_rejected");
    // The original (non-symlinked) file STILL serves fine.
    const real = await app.request("/hls/opening/seg-00009.ts");
    assert.equal(real.status, 200);
  });

  it("returns 404 for /hls (no stage path)", async () => {
    const res = await app.request("/hls");
    assert.equal(res.status, 404);
  });

  it("returns 404 for /hls/opening (no filename path)", async () => {
    const res = await app.request("/hls/opening");
    assert.equal(res.status, 404);
  });

  it("returns CORS header on every error response (so browsers see real status, not opaque CORS failure)", async () => {
    // Regression (Codex [P1]): without CORS on errors, hls.js sees
    // a 404 for a not-yet-written segment as an opaque load error
    // and breaks its retry/error logic.
    for (const url of [
      "/hls/no-such/index.m3u8", // 404 stage_not_found
      "/hls/bus/index.m3u8", // 410 stage_has_no_audio
      "/hls/opening/index.html", // 404 bad_filename
      "/hls/opening/seg-99999.ts", // 404 file_not_found
    ]) {
      const res = await app.request(url);
      assert.notEqual(res.status, 200, `${url} should not 200`);
      assert.equal(
        res.headers.get("access-control-allow-origin"),
        "*",
        `${url} must expose CORS header on error`,
      );
    }
  });

  it("returns 503 stage_not_running when registry says the stage is stopped (avoids stale audio)", async () => {
    // Regression (Codex round-3 [P2]): a supervisor that died
    // post-startup leaves its last m3u8 + segments on disk because
    // cleanStageDir only runs at supervisor START. Without the
    // liveness gate, /hls/<stage>/* would happily serve those
    // stale files while /api/stages/:id/now correctly reports the
    // stage as stopped.
    const registry = createStageRegistry();
    const stoppedCtl: StageController = {
      stageId: "opening",
      status: () => "stopped",
      currentTrack: () => null,
      snapshot: () => ({
        status: "stopped",
        track: null,
        trackStartedAt: null,
      }),
      setTracks: () => {},
      stop: async () => {},
      done: Promise.resolve(),
    };
    registry.register(stoppedCtl);

    const root = new Hono();
    root.route(
      "/hls",
      createHlsHandler({
        hlsRoot,
        catalog: [fakeStage("opening"), fakeStage("bus", true, null)],
        registry,
      }),
    );

    const res = await root.request("/hls/opening/index.m3u8");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string; stageId: string };
    assert.equal(body.error, "stage_not_running");
    assert.equal(body.stageId, "opening");
    // Liveness gate uses the same CORS middleware path.
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("returns 503 stage_not_running when registry has no controller for the stage", async () => {
    // Bootstrap hasn't registered this stage yet (still spinning up).
    const registry = createStageRegistry();
    const root = new Hono();
    root.route(
      "/hls",
      createHlsHandler({
        hlsRoot,
        catalog: [fakeStage("opening"), fakeStage("bus", true, null)],
        registry,
      }),
    );
    const res = await root.request("/hls/opening/index.m3u8");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "stage_not_running");
  });

  it("only accepts GET (no PUT/POST/DELETE)", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await app.request("/hls/opening/index.m3u8", { method });
      // Hono returns 404 for unmatched method+path combos; either way
      // it MUST NOT be 200/204.
      assert.notEqual(res.status, 200, `${method} should not succeed`);
      assert.notEqual(res.status, 204, `${method} should not succeed`);
    }
  });
});
