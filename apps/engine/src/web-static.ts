// Hono handler that serves the built Vite SPA from a directory on
// disk. Two responsibilities:
//
//   1. /assets/<file> — hashed Vite output (e.g. index-AbCd1234.js).
//      Long-cache because the filename hash already busts the cache
//      on every build.
//
//   2. anything else (and matching /index.html in particular) —
//      serve dist/index.html with no-cache so the SPA's HTML always
//      reflects the deployed dist (it's the only un-hashed file).
//      This is the SPA-fallback pattern: TanStack Router routes like
//      /stage/opening don't exist on the filesystem, so the engine
//      hands back index.html and the React app handles the route.
//
// Security posture mirrors src/hls.ts:
//   - Reject any path containing `..`, NUL, or backslash.
//   - Reject paths whose realpath() escapes the distDir.
//   - Reject symlinks anywhere in the resolved path.
//
// On Whatbox the engine is the sole user of the dist tree (operator
// owns it via rsync), so symlink rejection is more about defense in
// depth against future operator mistakes than about an attacker.

import { Hono } from "hono";
import { stat as fsStat, readFile, realpath } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import path from "node:path";

export interface WebStaticOptions {
  /** Absolute path to the Vite `dist/` directory. Must already
   *  contain index.html — the engine doesn't bootstrap-check this. */
  distDir: string;
  /** Optional path inside `distDir` to use for the SPA-fallback
   *  catchall. Defaults to `index.html`. */
  indexFile?: string;
}

const ASSETS_PREFIX = "/assets/";
const HASHED_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".woff2",
  ".woff",
  ".ttf",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".ico",
]);

/**
 * Map a filename extension to a MIME type. Vite's output covers a
 * narrow set; we list them explicitly so future asset additions
 * surface as a 200 + octet-stream rather than silent breakage.
 */
function mimeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    case ".ttf":
      return "font/ttf";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Resolve `relPath` under `distDir` and verify the result stays in
 * the directory and isn't a symlink. Returns the resolved absolute
 * path on success, or null on rejection (treat as 404).
 */
async function safeResolve(
  distDir: string,
  relPath: string,
): Promise<string | null> {
  // Cheap reject for traversal hints. realpath would also catch
  // these but failing fast keeps the error path quiet.
  if (
    relPath.includes("\0") ||
    relPath.includes("\\") ||
    /(^|\/)\.\.($|\/)/.test(relPath)
  ) {
    return null;
  }
  const candidate = path.join(distDir, relPath);
  let realDist: string;
  let realCandidate: string;
  try {
    realDist = await realpath(distDir);
    realCandidate = await realpath(candidate);
  } catch {
    // ENOENT / EACCES / loop. Caller treats null as 404.
    return null;
  }
  if (
    realCandidate !== realDist &&
    !realCandidate.startsWith(realDist + path.sep)
  ) {
    return null;
  }
  // Reject symlinks at the leaf (the most common operator footgun
  // would be a leaf symlink to /etc/passwd-style content).
  try {
    const lstats = await fsStat(realCandidate);
    if (!lstats.isFile()) return null;
  } catch {
    return null;
  }
  return realCandidate;
}

/**
 * Serve the SPA-fallback index.html with strict no-cache. Used for
 * the catchall route AND when an /assets/* request misses (so the
 * client gets a usable page instead of a JSON 404 — though hashed
 * filenames make the miss case essentially impossible).
 */
async function serveIndexHtml(distDir: string, indexFile: string) {
  const resolved = await safeResolve(distDir, indexFile);
  if (resolved === null) {
    return null;
  }
  const html = await readFile(resolved);
  return html;
}

export function createWebStaticHandler(opts: WebStaticOptions): Hono {
  const distDir = opts.distDir;
  const indexFile = opts.indexFile ?? "index.html";

  const app = new Hono();

  // Hashed assets — long cache. Vite's filename hash on every build
  // means the same URL always points at the same bytes.
  app.get("/assets/*", async (c) => {
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    if (!pathname.startsWith(ASSETS_PREFIX)) {
      return c.notFound();
    }
    const rel = pathname.slice(1); // drop leading slash
    const resolved = await safeResolve(distDir, rel);
    if (resolved === null) {
      return c.notFound();
    }
    c.header("content-type", mimeFor(resolved));
    const ext = path.extname(resolved).toLowerCase();
    if (HASHED_EXTENSIONS.has(ext)) {
      c.header("cache-control", "public, max-age=31536000, immutable");
    } else {
      c.header("cache-control", "no-cache");
    }
    const stream = Readable.toWeb(
      createReadStream(resolved),
    ) as ReadableStream<Uint8Array>;
    return c.body(stream);
  });

  // SPA-fallback catchall. Any GET that wasn't /api/*, /hls/*, or
  // /assets/* lands here. We hand back index.html and let TanStack
  // Router resolve the route in the browser.
  app.get("*", async (c) => {
    const html = await serveIndexHtml(distDir, indexFile);
    if (html === null) {
      // dist/index.html is missing — operator misconfigured the
      // deploy. Return 503 so a watchdog/healthcheck recognizes the
      // engine is up but the SPA isn't ready.
      return c.json(
        { error: "spa_index_missing", indexFile, distDir },
        503,
      );
    }
    c.header("content-type", "text/html; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(html);
  });

  return app;
}
