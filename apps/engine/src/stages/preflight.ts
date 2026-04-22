// Fast pre-flight validation of a track file before spawning ffmpeg.
//
// Why: a file that's missing, a dangling symlink, a directory, or an
// empty stub is going to make ffmpeg exit instantly. The supervisor
// then burns ~1.7 s in crash-retry-skip handling, and during cold
// start there's no rolling HLS buffer to hide that window from
// listeners. A microsecond `fs.stat` catches these cases up-front.
//
// We intentionally do NOT do codec-level validation here (no ffprobe):
// - It adds 50–200 ms per track per stage on the hot path.
// - It would need caching + concurrency control to be economical.
// - Header-level corruption is rare on Plex's curated library; the
//   existing crash-retry-skip path already handles it correctly for
//   the in-stream / mid-encode case anyway.
//
// See docs/WEEK0_LOG.md Req D: Plex paths are direct fs reads, so an
// `fs.stat` is authoritative.

import { stat } from "node:fs/promises";

/** A stub/empty file tells us nothing will decode; set a sane floor. */
const MIN_SIZE_BYTES = 1024; // 1 KiB — smaller than any real track.

export type PreflightReason =
  | "missing"
  | "not_a_regular_file"
  | "empty"
  | "too_small"
  | "stat_error";

export type PreflightResult =
  | { ok: true; sizeBytes: number }
  | { ok: false; reason: PreflightReason; detail?: string };

export async function preflightTrack(
  filePath: string,
): Promise<PreflightResult> {
  let s;
  try {
    s = await stat(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: false, reason: "missing" };
    return {
      ok: false,
      reason: "stat_error",
      detail: code ?? (err as Error).message,
    };
  }
  if (!s.isFile()) {
    return { ok: false, reason: "not_a_regular_file" };
  }
  if (s.size === 0) return { ok: false, reason: "empty" };
  if (s.size < MIN_SIZE_BYTES) {
    return {
      ok: false,
      reason: "too_small",
      detail: `${s.size} bytes`,
    };
  }
  return { ok: true, sizeBytes: s.size };
}
