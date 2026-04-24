// HTTP handler for the /hls/<stageId>/<file> static surface.
//
// Serves the per-stage HLS output the supervisor writes into
// /dev/shm/1008/radio-hls/<stageId>/. The path-traversal guard is
// the security-critical part: the request never directly indexes
// into the filesystem; we validate stageId against the static catalog
// and the filename against an exact regex BEFORE composing the path.
//
// Headers chosen to match what hls.js expects in a browser:
//   - .m3u8 → application/vnd.apple.mpegurl, Cache-Control: no-cache
//             (live profile, the playlist is rewritten every 3 s).
//   - .ts   → video/mp2t, Cache-Control: public, max-age=60
//             (segments are immutable; once written they don't change).
// CORS is wide-open (*) — this is a public radio served to whichever
// origin the web UI is hosted on, no credentials, no cookies.

import { stat, lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context, type Handler } from "hono";

import { STAGES, type Stage } from "@pavoia/shared";

import type { StageRegistry } from "./stages/registry.ts";

const SEGMENT_PATTERN = /^seg-\d+\.ts$/;
const PLAYLIST_NAME = "index.m3u8";

export interface CreateHlsHandlerInput {
  /** Absolute root dir under which each stage owns a subdir. */
  hlsRoot: string;
  /**
   * Override the catalog. Defaults to @pavoia/shared STAGES. Tests
   * can pass a smaller list — handler's behavior is identical, just
   * with fewer valid ids.
   */
  catalog?: readonly Stage[];
  /**
   * Optional registry. When provided, the handler refuses to serve
   * a stage whose controller is missing OR has reached the
   * "stopped" terminal state — the stage's last `index.m3u8` and
   * segment files would otherwise stick around on tmpfs and serve
   * stale audio (cleanStageDir only runs on supervisor START, not
   * on its termination). Returns 503 stage_not_running.
   *
   * When omitted (e.g. unit tests of the static surface), the
   * liveness gate is skipped and the handler trusts the catalog +
   * filename validation.
   */
  registry?: StageRegistry;
}

/**
 * Returns a Hono app that mounts the /hls/* surface under whatever
 * path the parent app uses to .route() it.
 */
export function createHlsHandler(input: CreateHlsHandlerInput): Hono {
  const { hlsRoot, catalog = STAGES, registry } = input;
  const hlsRootResolved = path.resolve(hlsRoot);
  // O(1) lookup for the stage validation hot path.
  const audioStageIds = new Set(
    catalog.filter((s) => !s.disabled).map((s) => s.id),
  );
  const disabledStageIds = new Set(
    catalog.filter((s) => s.disabled).map((s) => s.id),
  );

  const app = new Hono();

  // CORS on every response, including errors. hls.js + native iOS
  // surface non-CORS-friendly 4xx as opaque "load error" instead of
  // the actual status, which breaks normal HLS retry logic. The
  // success path also re-asserts these headers but it's cheap.
  app.use("/*", async (c, next) => {
    await next();
    if (!c.res.headers.has("access-control-allow-origin")) {
      c.res.headers.set("access-control-allow-origin", "*");
    }
  });

  // /hls/<stageId>/<filename> — index.m3u8 or seg-<digits>.ts only.
  app.get("/:stageId/:filename", (c) => {
    const ctx: ServeContext = {
      hlsRootResolved,
      audioStageIds,
      disabledStageIds,
      ...(registry !== undefined ? { registry } : {}),
    };
    return serveStageFile(c, ctx);
  });

  // Anything else under /hls/* (eg /hls or /hls/<stage>/) is 404.
  app.all("/*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}

interface ServeContext {
  hlsRootResolved: string;
  audioStageIds: ReadonlySet<string>;
  disabledStageIds: ReadonlySet<string>;
  registry?: StageRegistry;
}

async function serveStageFile(
  c: Context,
  ctx: ServeContext,
): Promise<Response> {
  const stageId = c.req.param("stageId") ?? "";
  const filename = c.req.param("filename") ?? "";

  // 1. Validate stage id against the catalog. Returning a structured
  //    error makes curl-debugging this surface tractable.
  if (ctx.disabledStageIds.has(stageId)) {
    return c.json({ error: "stage_has_no_audio", stageId }, 410);
  }
  if (!ctx.audioStageIds.has(stageId)) {
    return c.json({ error: "stage_not_found", stageId }, 404);
  }

  // 2. Validate filename. Only the playlist or numeric segments — no
  //    dotfiles, no traversal sequences, no unexpected extensions.
  //    The regex anchor is what makes the safety claim tight.
  const isPlaylist = filename === PLAYLIST_NAME;
  const isSegment = SEGMENT_PATTERN.test(filename);
  if (!isPlaylist && !isSegment) {
    return c.json({ error: "bad_filename" }, 404);
  }

  // 2a. Liveness gate. cleanStageDir only runs at supervisor START,
  //     so if a supervisor terminated (fast-death cap, fallback
  //     failure, etc.) the last m3u8 + segments would still be on
  //     disk and we'd happily serve them — stale audio while
  //     /api/stages/:id/now correctly reports the stage as stopped.
  //     We only allow `playing` / `curating` — the states where the
  //     supervisor is actively producing audio.
  //
  //     `starting` and `stopping` are deliberately rejected too:
  //     spawnAndWatch registers a replacement controller BEFORE
  //     startStage runs cleanStageDir, so requests in that window
  //     could read the previous run's stale files. Returning 503
  //     during the transition gives clients a retriable signal
  //     instead of stale audio.
  if (ctx.registry !== undefined) {
    const controller = ctx.registry.get(stageId);
    const status = controller?.status();
    if (status !== "playing" && status !== "curating") {
      return c.json({ error: "stage_not_running", stageId }, 503);
    }
  }

  // 3. Compose + verify the resolved path is INSIDE hlsRoot/stageId/.
  //    With (1) and (2) already validated this is belt-and-suspenders,
  //    but cheap, and protects against future relaxations of the
  //    catalog or filename rules.
  const stageDir = path.join(ctx.hlsRootResolved, stageId);
  const fullPath = path.join(stageDir, filename);
  const rel = path.relative(stageDir, fullPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return c.json({ error: "path_traversal" }, 400);
  }

  // 4. Symlink rejection + containment + read. The path-text checks
  //    at (3) are necessary but not sufficient — `stat()` and
  //    `readFile()` follow symlinks, so multiple kinds of symlink
  //    can escape the stage dir:
  //      - a symlinked seg-*.ts inside the stage dir
  //      - the stageDir ITSELF being a symlink to /tmp/evil
  //    Both must be rejected. Layered defense:
  //      a. lstat stageDir + the requested file; reject either if
  //         it's a symbolic link. Catches the obvious cases up
  //         front before we touch realpath.
  //      b. realpath the requested file, then verify it's still
  //         under ctx.hlsRootResolved (the operator-configured root,
  //         resolved at handler creation). Catches indirect
  //         symlinks at any intermediate path component, no matter
  //         how creative.
  //    Then read. Sub-100 KB segments + tiny m3u8 — full-buffer
  //    reads are simpler than streaming and don't measurably hurt
  //    throughput for HLS.
  let bytes: Buffer;
  try {
    const [stageDirInfo, fileInfo] = await Promise.all([
      lstat(stageDir),
      lstat(fullPath),
    ]);
    if (stageDirInfo.isSymbolicLink() || fileInfo.isSymbolicLink()) {
      return c.json({ error: "symlink_rejected" }, 400);
    }
    const fullPathReal = await realpath(fullPath);
    const relToRoot = path.relative(ctx.hlsRootResolved, fullPathReal);
    if (
      relToRoot === "" ||
      relToRoot.startsWith("..") ||
      path.isAbsolute(relToRoot)
    ) {
      return c.json({ error: "path_traversal" }, 400);
    }
    const s = await stat(fullPathReal);
    if (!s.isFile()) {
      return c.json({ error: "not_a_file" }, 404);
    }
    bytes = await readFile(fullPathReal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "file_not_found" }, 404);
    }
    throw err;
  }

  // 5. Headers. Tuned for hls.js + native Safari/iOS:
  //    - .m3u8 must not cache (live playlist rewritten every 3 s).
  //    - .ts segments use a short max-age but are NOT marked
  //      immutable. Reason: each supervisor start runs cleanStageDir
  //      and ffmpeg's seg-%05d.ts numbering restarts at 00000, so
  //      `/hls/<stage>/seg-00000.ts` refers to different bytes after
  //      a deploy / watchdog restart. With `immutable`, browsers
  //      and shared caches would replay stale audio for the full
  //      max-age window after a restart. max-age=10 is enough for a
  //      single listener to fetch each segment exactly once during
  //      its rolling-window lifetime (~18 s on the server) without
  //      a re-request, and short enough to bound the stale-audio
  //      window after restart.
  //    - CORS open, no credentials — public radio.
  //    - content-length comes from the BUFFER WE'RE SENDING, not the
  //      stat result, so a m3u8 rewrite between stat() and readFile()
  //      can't make us advertise a stale size that some HLS clients
  //      treat as a truncated playlist reload.
  const headers: Record<string, string> = {
    "content-type": isPlaylist
      ? "application/vnd.apple.mpegurl"
      : "video/mp2t",
    "content-length": String(bytes.length),
    "cache-control": isPlaylist
      ? "no-cache, no-store, must-revalidate"
      : "public, max-age=10",
    "access-control-allow-origin": "*",
  };
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
