// Filesystem helpers for a stage's HLS output directory.
//
// On Whatbox the target is /dev/shm/1008/radio-hls/<stage>/ (Req F);
// locally it's a tmpdir. Either way the supervisor owns the dir and:
//
//   - prepareStageDir: `mkdir -p` on start, idempotent.
//   - cleanStageDir:   remove stale index.m3u8 + seg-*.ts from a previous
//                      run (tmpfs survives a crash even when the engine
//                      process dies). Non-HLS files in the dir are left
//                      alone — nothing else lives there today, but being
//                      conservative costs nothing.
//
// Called once at stage-start only. Between tracks, segment continuity
// relies on ffmpeg's +append_list flag reading the existing m3u8 and
// continuing segment numbering — do NOT clean mid-run.

import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const SEGMENT_PATTERN = /^seg-\d+\.ts$/;
const PLAYLIST_NAME = "index.m3u8";

export async function prepareStageDir(stageHlsDir: string): Promise<void> {
  await mkdir(stageHlsDir, { recursive: true });
}

/**
 * Returns the number of files removed. Silently tolerates a missing
 * directory (returns 0) so callers can call it unconditionally on
 * startup.
 */
export async function cleanStageDir(stageHlsDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(stageHlsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const name of entries) {
    if (name === PLAYLIST_NAME || SEGMENT_PATTERN.test(name)) {
      await rm(path.join(stageHlsDir, name), { force: true });
      removed++;
    }
  }
  return removed;
}

/**
 * Called between ffmpeg invocations to clean up segment files that
 * ffmpeg left behind but are no longer listed in index.m3u8.
 *
 * Why this exists: ffmpeg's `delete_segments` flag removes segments as
 * they roll off the playlist, but with a `hls_delete_threshold` delay
 * (default 1 extra segment). When ffmpeg exits, any segments queued
 * for deletion may not have been removed yet. Over many track
 * transitions on a long-running stage, these accumulate in /dev/shm.
 *
 * Safe semantics: we only delete segments that (a) match the
 * `seg-<digits>.ts` pattern AND (b) are NOT referenced by the current
 * playlist. Anything a listener could legitimately fetch is in the
 * playlist, so this cannot race with an in-flight HTTP GET.
 *
 * Returns the number of files removed. Silently tolerates a missing
 * directory or missing playlist (returns 0).
 */
export async function pruneOrphanSegments(
  stageHlsDir: string,
): Promise<number> {
  const playlistPath = path.join(stageHlsDir, PLAYLIST_NAME);
  let playlist: string;
  try {
    playlist = await readFile(playlistPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  const referenced = new Set<string>();
  for (const rawLine of playlist.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    // HLS entries can be bare names, relative paths, or absolute paths
    // depending on how ffmpeg was configured. Take the basename and
    // match against the seg-*.ts pattern.
    const basename = line.split("/").pop() ?? "";
    if (SEGMENT_PATTERN.test(basename)) {
      referenced.add(basename);
    }
  }

  let entries: string[];
  try {
    entries = await readdir(stageHlsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }

  let removed = 0;
  for (const name of entries) {
    if (SEGMENT_PATTERN.test(name) && !referenced.has(name)) {
      await rm(path.join(stageHlsDir, name), { force: true });
      removed++;
    }
  }
  return removed;
}
