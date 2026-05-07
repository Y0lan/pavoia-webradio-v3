// Read-only Plex proxy. Forwards a narrow surface of Plex API GETs to
// the Plex server with the engine's X-Plex-Token attached server-side
// — the client never sees the token. Two endpoints:
//
//   GET /api/plex/thumb/:metadataKey/:thumbId
//     Streams the album/artist thumbnail bytes. The Plex `coverUrl`
//     on a Track has shape `/library/metadata/:key/thumb/:id`; this
//     route mirrors the path components so a thin client-side helper
//     can rewrite `/library/metadata/X/thumb/Y` → `/api/plex/thumb/X/Y`.
//
//   GET /api/plex/artist/:ratingKey
//     Returns clean JSON with the artist bio, summary, thumb proxy
//     URL, and similar-artists list. Lets us power the ArtistDrawer
//     without exposing the raw Plex API surface.
//
// Why this module exists separate from PlexClient:
//   PlexClient is shaped for the supervisor's playlist fetch — it
//   parses Track schemas, filters by libraryRoot, decodes UTF-8.
//   The proxy passes opaque media bytes through, so it has different
//   error semantics (HTTP-mirroring rather than typed Plex errors).

import { Hono, type Context } from "hono";

import type { PlexClientConfig } from "./client.ts";

export interface PlexProxyOptions {
  baseUrl: PlexClientConfig["baseUrl"];
  token: PlexClientConfig["token"];
  /** How long to wait for Plex to respond before aborting. Default 10 s. */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

const DIGITS_ONLY = /^\d+$/;
const DEFAULT_TIMEOUT_MS = 10_000;
// Plex thumbs are PNG/JPEG and well under 1 MB; cap the proxy payload
// to keep an attacker who somehow hijacks the path from streaming
// arbitrary-sized binaries through us. 4 MB is generous.
const MAX_THUMB_BYTES = 4 * 1024 * 1024;

interface PlexMetadataNode {
  ratingKey?: string | number;
  type?: string;
  title?: string;
  summary?: string;
  thumb?: string;
  art?: string;
  Country?: { tag?: string }[];
  Genre?: { tag?: string }[];
}

interface PlexLibraryResponse {
  MediaContainer?: {
    Metadata?: PlexMetadataNode[];
  };
}

export interface PublicArtist {
  ratingKey: string;
  title: string;
  summary: string;
  /** Engine-rewritten thumb URL or null. */
  thumb: string | null;
  country: string[];
  genre: string[];
  similar: PublicArtistSimilar[];
}

export interface PublicArtistSimilar {
  ratingKey: string;
  title: string;
  thumb: string | null;
}

/**
 * Translate a Plex thumb path (`/library/metadata/:key/thumb/:id`) into
 * the engine's proxy URL (`/api/plex/thumb/:key/:id`). Returns null if
 * the input doesn't match the expected shape — we don't proxy
 * arbitrary Plex paths.
 */
export function rewriteThumbToProxy(plexPath: string | null | undefined): string | null {
  if (!plexPath) return null;
  const m = plexPath.match(/^\/library\/metadata\/(\d+)\/thumb\/(\d+)$/);
  if (!m) return null;
  return `/api/plex/thumb/${m[1]}/${m[2]}`;
}

export function createPlexProxy(opts: PlexProxyOptions): Hono {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stripped = opts.baseUrl.replace(/\/+$/, "");

  const app = new Hono();

  // ── Thumb proxy ─────────────────────────────────────────────
  app.get("/thumb/:metadataKey/:thumbId", async (c) => {
    const metadataKey = c.req.param("metadataKey");
    const thumbId = c.req.param("thumbId");
    if (!DIGITS_ONLY.test(metadataKey) || !DIGITS_ONLY.test(thumbId)) {
      return c.json({ error: "invalid_thumb_id" }, 400);
    }

    const url = `${stripped}/library/metadata/${metadataKey}/thumb/${thumbId}`;
    return await proxyBinary(c, url, fetchImpl, opts.token, timeoutMs);
  });

  // ── Artist info ─────────────────────────────────────────────
  app.get("/artist/:ratingKey", async (c) => {
    const ratingKey = c.req.param("ratingKey");
    if (!DIGITS_ONLY.test(ratingKey)) {
      return c.json({ error: "invalid_rating_key" }, 400);
    }

    try {
      const detail = await fetchPlexJson<PlexLibraryResponse>(
        `${stripped}/library/metadata/${ratingKey}`,
        opts.token,
        fetchImpl,
        timeoutMs,
      );
      const node = detail?.MediaContainer?.Metadata?.[0];
      if (!node) return c.json({ error: "artist_not_found" }, 404);
      if (node.type !== "artist") {
        return c.json({ error: "not_an_artist", got: node.type ?? null }, 400);
      }

      // Similar artists — endpoint may legitimately return empty.
      let similar: PublicArtistSimilar[] = [];
      try {
        const similarRes = await fetchPlexJson<PlexLibraryResponse>(
          `${stripped}/library/metadata/${ratingKey}/similar`,
          opts.token,
          fetchImpl,
          timeoutMs,
        );
        similar = (similarRes?.MediaContainer?.Metadata ?? [])
          .filter((m) => m.type === "artist")
          .map((m) => ({
            ratingKey: String(m.ratingKey ?? ""),
            title: m.title ?? "Unknown artist",
            thumb: rewriteThumbToProxy(m.thumb ?? null),
          }))
          .filter((m) => m.ratingKey !== "");
      } catch {
        // Plex versions without "Sonic Analysis" / similar disabled
        // return 404 here. Treat as "no similar artists" rather than
        // failing the whole artist response.
      }

      const artist: PublicArtist = {
        ratingKey: String(node.ratingKey ?? ratingKey),
        title: node.title ?? "Unknown artist",
        summary: node.summary ?? "",
        thumb: rewriteThumbToProxy(node.thumb ?? null),
        country: (node.Country ?? [])
          .map((g) => g.tag)
          .filter((t): t is string => typeof t === "string"),
        genre: (node.Genre ?? [])
          .map((g) => g.tag)
          .filter((t): t is string => typeof t === "string"),
        similar,
      };
      return c.json(artist);
    } catch (err) {
      // Plex unreachable / malformed JSON / timeout. Return a 502 so
      // the watchdog (which only cares about HTTP 000) doesn't get
      // confused; client can retry.
      return c.json(
        {
          error: "plex_upstream_error",
          message: err instanceof Error ? err.message : String(err),
        },
        502,
      );
    }
  });

  return app;
}

async function proxyBinary(
  c: Context,
  url: string,
  fetchImpl: typeof fetch,
  token: string,
  timeoutMs: number,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Plex-Token": token,
        Accept: "image/*",
      },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    return c.json(
      {
        error: "plex_upstream_error",
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    return c.json(
      { error: "plex_upstream_error", status: res.status },
      res.status === 404 ? 404 : 502,
    );
  }

  // Cache header — Plex thumbs are content-addressable (the URL
  // contains the timestamp suffix), so they're safe to cache hard
  // in the browser. Engine forwards Plex's content-type.
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const contentLength = res.headers.get("content-length");
  if (contentLength !== null) {
    const n = Number(contentLength);
    if (Number.isFinite(n) && n > MAX_THUMB_BYTES) {
      return c.json({ error: "thumb_too_large", bytes: n }, 502);
    }
  }
  c.header("content-type", contentType);
  c.header("cache-control", "public, max-age=86400, immutable");
  if (res.body === null) {
    return c.body(null, 204);
  }
  return c.body(res.body);
}

async function fetchPlexJson<T>(
  url: string,
  token: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "X-Plex-Token": token,
        Accept: "application/json",
      },
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`Plex returned HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}
