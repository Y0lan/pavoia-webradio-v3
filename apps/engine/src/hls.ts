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

import { stat, readFile } from "node:fs/promises";
import path from "node:path";
import { Hono, type Context, type Handler } from "hono";

import { STAGES, type Stage } from "@pavoia/shared";

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
}

/**
 * Returns a Hono app that mounts the /hls/* surface under whatever
 * path the parent app uses to .route() it.
 */
export function createHlsHandler(input: CreateHlsHandlerInput): Hono {
  const { hlsRoot, catalog = STAGES } = input;
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
  app.get("/:stageId/:filename", (c) =>
    serveStageFile(c, {
      hlsRootResolved,
      audioStageIds,
      disabledStageIds,
    }),
  );

  // Anything else under /hls/* (eg /hls or /hls/<stage>/) is 404.
  app.all("/*", (c) => c.json({ error: "not_found" }, 404));

  return app;
}

interface ServeContext {
  hlsRootResolved: string;
  audioStageIds: ReadonlySet<string>;
  disabledStageIds: ReadonlySet<string>;
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

  // 4. Read the file. Sub-100 KB segments + tiny m3u8 — full-buffer
  //    reads are simpler than streaming and don't measurably hurt
  //    throughput for HLS.
  let bytes: Buffer;
  try {
    const s = await stat(fullPath);
    if (!s.isFile()) {
      return c.json({ error: "not_a_file" }, 404);
    }
    bytes = await readFile(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "file_not_found" }, 404);
    }
    throw err;
  }

  // 5. Headers. Tuned for hls.js + native Safari/iOS:
  //    - .m3u8 must not cache (live playlist rewritten every 3 s).
  //    - .ts segments are immutable for their HLS-window lifetime.
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
      : "public, max-age=60, immutable",
    "access-control-allow-origin": "*",
  };
  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
