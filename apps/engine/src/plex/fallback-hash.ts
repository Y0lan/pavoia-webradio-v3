import { createHash } from "node:crypto";

/**
 * Stable identity hash for a track independent of Plex's `ratingKey`.
 *
 * Plex re-indexes (library scans, metadata updates) can rotate `ratingKey`
 * for the same underlying file. We need a second identity token so play
 * history and discovery feeds survive re-indexes. This composes the three
 * human-facing strings that together identify a track in practice.
 *
 * Per WEEK0_LOG.md / SLIM_V3 Codex finding #21:
 *   Track identity = (plex_rating_key, fallback_hash(artist, title, album))
 *
 * Output: 16 hex chars of a SHA-256 (64 bits of entropy — enough to make
 * accidental collisions on a library of ~20k tracks vanishingly unlikely,
 * short enough to fit in log lines).
 *
 * Inputs are NFC-normalised before hashing so `é` (U+00E9) and `é`
 * (U+0065 + U+0301) hash identically.
 */
export function fallbackHash(
  artist: string,
  title: string,
  album: string,
): string {
  const canon = [artist, title, album]
    .map((s) => s.normalize("NFC").trim())
    .join("\u0000");
  return createHash("sha256").update(canon, "utf8").digest("hex").slice(0, 16);
}
