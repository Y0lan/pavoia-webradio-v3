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

import { mkdir, readdir, rm } from "node:fs/promises";
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
