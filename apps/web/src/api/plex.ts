import { useQuery } from "@tanstack/react-query";

import { ApiError } from "./stages.ts";

/**
 * Translate a raw Plex thumb path returned by the engine
 * (`/library/metadata/:key/thumb/:id`) into the engine's proxy URL
 * (`/api/plex/thumb/:key/:id`). Returns null when the input doesn't
 * match the expected shape — caller falls back to the gradient
 * placeholder.
 *
 * Mirrors the server-side rewrite in apps/engine/src/plex/proxy.ts so
 * the same canonical mapping is applied either way.
 */
export function coverProxyUrl(plexCoverUrl: string | null | undefined): string | null {
  if (!plexCoverUrl) return null;
  const m = plexCoverUrl.match(/^\/library\/metadata\/(\d+)\/thumb\/(\d+)$/);
  if (!m) return null;
  return `/api/plex/thumb/${m[1]}/${m[2]}`;
}

export interface PublicArtistSimilar {
  ratingKey: string;
  title: string;
  thumb: string | null;
}

export interface PublicArtist {
  ratingKey: string;
  title: string;
  summary: string;
  thumb: string | null;
  country: string[];
  genre: string[];
  similar: PublicArtistSimilar[];
}

async function fetchArtist(ratingKey: number | string): Promise<PublicArtist> {
  const res = await fetch(
    `/api/plex/artist/${encodeURIComponent(String(ratingKey))}`,
  );
  if (!res.ok) {
    throw new ApiError(`/api/plex/artist returned HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as PublicArtist;
}

/**
 * Fetch a single artist by ratingKey. Pass `null` to disable.
 * Generous staleTime — artist metadata barely changes.
 */
export function useArtist(ratingKey: number | null) {
  return useQuery({
    queryKey: ["artist", ratingKey ?? "__none__"],
    queryFn: () => fetchArtist(ratingKey ?? 0),
    enabled: ratingKey !== null,
    staleTime: 5 * 60_000, // 5 min
    retry: 1,
  });
}
