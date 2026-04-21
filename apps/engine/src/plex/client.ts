// Plex HTTP client for v3 engine.
//
// Single responsibility: given a playlist ratingKey, return a list of
// playable Track objects. No caching, no retries — the caller (stage
// supervisor, lands in Task 3) decides the polling cadence (60s per
// SLIM_V3 §"Audio engine").
//
// Error taxonomy is structured so supervisors can react differently to
// "we need to retry" (network) vs "this stage is broken and needs
// curator attention" (auth / not-found).

import { resolve as resolvePath, relative as relativePath } from "node:path";
import type { Track } from "@pavoia/shared";
import { PlexPlaylistItemsResponse } from "./schema.ts";
import type { PlexTrackMetadataT } from "./schema.ts";
import { fallbackHash } from "./fallback-hash.ts";

/** Hard ceiling for how many items we'll pull from a single playlist.
 *  Largest current stage (bermuda-night) is 2040 tracks; 20 000 gives
 *  plenty of headroom, and Plex's self-imposed per-request cap is
 *  usually much higher on self-hosted installs. Pagination kicks in
 *  if a playlist exceeds this — see fetchPlaylist below. */
const REQUEST_PAGE_SIZE = 5000;

/** Hard ceiling across all pages — refuses to keep paginating if a
 *  playlist ever gets absurdly large (which would indicate a Plex bug
 *  or a malicious response). */
const MAX_TOTAL_TRACKS = 50_000;

export type PlexClientConfig = {
  /** Base URL of the Plex server, including scheme + port. e.g. `http://127.0.0.1:31711`. */
  baseUrl: string;
  /** Plex auth token (`X-Plex-Token`). Sent as header, never in query string. */
  token: string;
  /** Absolute library root — every track's `Part.file` must resolve to a path
      inside this directory or it is dropped (Req D security guard).
      Comparison is done via `path.resolve` so `..` traversal is rejected. */
  libraryRoot: string;
  /** Abort the HTTP request (headers AND body) if Plex doesn't respond
      within this many ms. Defaults to 10 s. */
  timeoutMs?: number;
  /** Override for tests. Shape matches the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Called once per skipped track with a human-readable reason.
      Defaults to a silent no-op; the stage supervisor (Task 3) is where
      dedup / log cadence decisions belong, not inside the client. */
  onSkip?: (reason: PlexSkipReason) => void;
};

export type PlexSkipReason = {
  ratingKey: string | null;
  title: string | null;
  reason:
    | "not_a_track"
    | "missing_media"
    | "empty_path"
    | "path_outside_library"
    | "invalid_rating_key";
  detail?: string;
};

export type PlexError =
  | { kind: "network"; cause: unknown }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "auth" }
  | { kind: "not_found"; ratingKey: number }
  | { kind: "server"; status: number }
  | { kind: "unexpected_status"; status: number }
  | { kind: "invalid_response"; issues: string[] }
  | { kind: "too_many_tracks"; limit: number };

export class PlexApiError extends Error {
  readonly detail: PlexError;
  constructor(detail: PlexError, message?: string) {
    super(message ?? detail.kind);
    this.name = "PlexApiError";
    this.detail = detail;
  }

  /** Structured serializer for logs. Redacts `cause.stack` to keep log
   *  lines bounded, and never includes the token (which isn't in `detail`
   *  anyway — constructor never stores it). */
  toJSON(): { name: string; message: string; detail: PlexError } {
    let detail = this.detail;
    if (detail.kind === "network") {
      const c = detail.cause;
      detail = {
        kind: "network",
        cause:
          c instanceof Error
            ? { name: c.name, message: c.message, code: (c as NodeJS.ErrnoException).code }
            : typeof c === "object"
              ? String(c)
              : c,
      };
    }
    return { name: this.name, message: this.message, detail };
  }
}

export type FetchPlaylistResult = {
  ratingKey: number;
  tracks: Track[];
  /** Count of Plex entries that were dropped (non-track type, missing file,
      path outside library). Observability — callers can surface in /health. */
  skipped: number;
};

export type PlexClient = {
  fetchPlaylist(ratingKey: number): Promise<FetchPlaylistResult>;
};

export function createPlexClient(config: PlexClientConfig): PlexClient {
  const {
    baseUrl,
    token,
    libraryRoot,
    timeoutMs = 10_000,
    fetchImpl = fetch,
    onSkip = () => {},
  } = config;

  const root = baseUrl.replace(/\/+$/, "");
  const libRootAbsolute = resolvePath(libraryRoot);

  async function fetchPage(
    ratingKey: number,
    start: number,
    size: number,
  ): Promise<{ size: number; totalSize: number | undefined; metadata: PlexTrackMetadataT[] }> {
    const url = `${root}/playlists/${ratingKey}/items?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "GET",
          signal: ac.signal,
          headers: {
            Accept: "application/json",
            "X-Plex-Token": token,
          },
        });
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          throw new PlexApiError({ kind: "timeout", timeoutMs }, `plex timed out after ${timeoutMs}ms`);
        }
        throw new PlexApiError({ kind: "network", cause: err }, "plex network error");
      }

      if (res.status === 401 || res.status === 403) {
        throw new PlexApiError({ kind: "auth" }, "plex auth rejected");
      }
      if (res.status === 404) {
        throw new PlexApiError({ kind: "not_found", ratingKey }, `plex playlist ${ratingKey} not found`);
      }
      if (res.status >= 500) {
        throw new PlexApiError({ kind: "server", status: res.status }, `plex server error ${res.status}`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new PlexApiError({ kind: "unexpected_status", status: res.status }, `plex unexpected status ${res.status}`);
      }

      let payload: unknown;
      try {
        // Body read is inside the abort timer; if Plex stalls mid-body,
        // the AbortController will cancel the stream.
        payload = await res.json();
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError") {
          throw new PlexApiError({ kind: "timeout", timeoutMs }, `plex body read timed out after ${timeoutMs}ms`);
        }
        throw new PlexApiError(
          { kind: "invalid_response", issues: ["response body is not valid JSON"] },
          `plex returned non-JSON response: ${(err as Error).message}`,
        );
      }

      const parsed = PlexPlaylistItemsResponse.safeParse(payload);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(
          (i) => `${i.path.join(".") || "<root>"}: ${i.message}`,
        );
        throw new PlexApiError(
          { kind: "invalid_response", issues },
          `plex response failed schema validation: ${issues.slice(0, 3).join("; ")}`,
        );
      }

      const mc = parsed.data.MediaContainer;
      const metadata = mc.Metadata ?? [];
      const pageSize = mc.size;
      // `totalSize` is advisory. Some Plex versions omit it; collapsing
      // undefined → pageSize would falsely cap large playlists at one
      // page. Return undefined when unknown and let the caller keep
      // paging until it sees an empty page or hits MAX_TOTAL_TRACKS.
      const totalSize = mc.totalSize ?? undefined;

      if (pageSize > 0 && metadata.length === 0) {
        throw new PlexApiError(
          { kind: "invalid_response", issues: [`MediaContainer.size=${pageSize} but Metadata is empty`] },
          `plex response inconsistent: size=${pageSize} Metadata.length=0`,
        );
      }

      return { size: pageSize, totalSize, metadata };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchPlaylist(ratingKey: number): Promise<FetchPlaylistResult> {
    if (!Number.isSafeInteger(ratingKey) || ratingKey < 1) {
      throw new PlexApiError(
        { kind: "invalid_response", issues: [`invalid ratingKey: ${ratingKey}`] },
        `invalid ratingKey: ${ratingKey}`,
      );
    }

    const tracks: Track[] = [];
    let skipped = 0;
    let fetched = 0;
    let totalSize: number | undefined;

    while (totalSize === undefined || fetched < totalSize) {
      const page = await fetchPage(ratingKey, fetched, REQUEST_PAGE_SIZE);
      // Adopt totalSize the first time Plex reports it. If Plex keeps
      // omitting it, we keep paging until a short page arrives.
      totalSize = page.totalSize ?? totalSize;

      if (totalSize !== undefined && totalSize > MAX_TOTAL_TRACKS) {
        throw new PlexApiError(
          { kind: "too_many_tracks", limit: MAX_TOTAL_TRACKS },
          `playlist ${ratingKey} reports totalSize=${totalSize}, refusing (limit ${MAX_TOTAL_TRACKS})`,
        );
      }

      if (page.metadata.length === 0) break; // nothing left, escape

      for (const entry of page.metadata) {
        const track = mapEntryToTrack(entry, libRootAbsolute, onSkip);
        if (track === null) {
          skipped++;
          continue;
        }
        tracks.push(track);
      }

      fetched += page.size;

      // Circuit breaker: if Plex never reports totalSize, refuse to
      // keep paging past the ceiling. Protects against a broken Plex
      // response pinning the engine in an infinite paging loop.
      if (totalSize === undefined && fetched >= MAX_TOTAL_TRACKS) {
        throw new PlexApiError(
          { kind: "too_many_tracks", limit: MAX_TOTAL_TRACKS },
          `playlist ${ratingKey} reached ${MAX_TOTAL_TRACKS} items without Plex reporting totalSize`,
        );
      }
    }

    return { ratingKey, tracks, skipped };
  }

  return { fetchPlaylist };
}

function mapEntryToTrack(
  entry: PlexTrackMetadataT,
  libRootAbsolute: string,
  onSkip: (r: PlexSkipReason) => void,
): Track | null {
  if (entry.type !== "track") {
    onSkip({
      ratingKey: entry.ratingKey,
      title: entry.title,
      reason: "not_a_track",
      detail: `type=${entry.type}`,
    });
    return null;
  }

  const firstMedia = entry.Media?.[0];
  if (firstMedia === undefined) {
    onSkip({ ratingKey: entry.ratingKey, title: entry.title, reason: "missing_media" });
    return null;
  }
  const firstPart = firstMedia.Part?.[0];
  if (firstPart === undefined || !firstPart.file) {
    onSkip({ ratingKey: entry.ratingKey, title: entry.title, reason: "empty_path" });
    return null;
  }

  // Normalize away `..` components and symlink-style relative prefixes.
  // We intentionally don't `realpath` — that would require the file to
  // exist on disk, which isn't true on the dev machine, and symlinks inside
  // the library are legitimate use in this project.
  const resolved = resolvePath(firstPart.file);
  const rel = relativePath(libRootAbsolute, resolved);
  const outsideLib =
    rel === "" ||
    rel.startsWith("..") ||
    (rel.length >= 1 && rel[0] === "/"); // rel is absolute → outside root
  if (outsideLib) {
    onSkip({
      ratingKey: entry.ratingKey,
      title: entry.title,
      reason: "path_outside_library",
      detail: firstPart.file,
    });
    return null;
  }

  const ratingKeyNum = Number(entry.ratingKey);
  if (!Number.isSafeInteger(ratingKeyNum) || ratingKeyNum < 1) {
    onSkip({
      ratingKey: entry.ratingKey,
      title: entry.title,
      reason: "invalid_rating_key",
      detail: `ratingKey="${entry.ratingKey}"`,
    });
    return null;
  }

  const artist = entry.grandparentTitle ?? "Unknown artist";
  const album = entry.parentTitle ?? "";

  return {
    plexRatingKey: ratingKeyNum,
    fallbackHash: fallbackHash(artist, entry.title, album),
    title: entry.title,
    artist,
    album,
    albumYear: entry.parentYear ?? null,
    durationSec:
      entry.duration !== undefined && entry.duration !== null
        ? Math.round(entry.duration / 1000)
        : 0,
    filePath: resolved,
    coverUrl: entry.thumb ?? null,
  };
}
