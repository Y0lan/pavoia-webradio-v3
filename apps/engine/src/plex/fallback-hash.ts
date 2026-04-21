import { createHash } from "node:crypto";

/**
 * Generate a stable 16-character hex identity token for a track from artist, title, and album.
 *
 * Inputs are normalized to Unicode NFC and trimmed before canonicalization; the resulting canonical
 * string is hashed with SHA-256 and the first 16 hex characters of the digest are returned.
 *
 * @returns A 16-character lowercase hex string derived from the SHA-256 digest of the normalized inputs
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
