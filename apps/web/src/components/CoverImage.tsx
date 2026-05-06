import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { coverProxyUrl } from "../api/plex.ts";

interface CoverImageProps {
  /** Raw Plex cover URL (e.g. /library/metadata/.../thumb/...). */
  plexCoverUrl: string | null | undefined;
  /** Tailwind classes for the wrapper div (sizing, ring, rounded, etc.). */
  className?: string;
  /** When the proxy URL is null OR the image fails to load, render this
   *  fallback inside the same square frame. */
  fallback: ReactNode;
  /** Optional inline style passthrough on the wrapper div. */
  style?: CSSProperties;
  /** Loading hint for the underlying <img>. Defaults to "lazy". */
  loading?: "lazy" | "eager";
}

/**
 * Square Plex cover image with graceful fallback. Shows the proxied
 * Plex thumb when available; on any image-load error (404 from a
 * stale ratingKey, 502 from an unreachable Plex, network timeout)
 * swaps to the gradient/vinyl fallback the caller passes in.
 *
 * The `coverFailed` flag resets whenever the track changes (the
 * proxied URL is the cache key) so a transient failure on one track
 * doesn't suppress the next track's cover.
 */
export function CoverImage({
  plexCoverUrl,
  className = "",
  fallback,
  style,
  loading = "lazy",
}: CoverImageProps) {
  const proxied = coverProxyUrl(plexCoverUrl);
  const [failed, setFailed] = useState(false);

  // Reset the failed flag when the track changes so a transient
  // failure on one cover doesn't poison subsequent renders.
  useEffect(() => {
    setFailed(false);
  }, [proxied]);

  if (proxied && !failed) {
    return (
      <div className={`relative overflow-hidden ${className}`} style={style}>
        <img
          src={proxied}
          alt=""
          loading={loading}
          decoding="async"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden ${className}`} style={style}>
      {fallback}
    </div>
  );
}
