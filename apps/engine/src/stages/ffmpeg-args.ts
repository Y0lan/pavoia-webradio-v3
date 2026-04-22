// Pure ffmpeg argv builder for a single track -> HLS transcode.
//
// Locks WEEK0_LOG reqs:
//   K: -hls_flags +append_list+omit_endlist+delete_segments (rolling window)
//   L: -hls_time 3, -hls_list_size 6
//   M: segment filename pattern seg-%05d.ts
//   P: AAC 128 kbps stereo 44.1 kHz, video stripped

import path from "node:path";

export interface BuildFfmpegArgsInput {
  /** Absolute path to the audio file ffmpeg will read. */
  trackFilePath: string;
  /** Absolute directory where the m3u8 and .ts segments are written. */
  stageHlsDir: string;
}

export function buildFfmpegArgs(input: BuildFfmpegArgsInput): string[] {
  const { trackFilePath, stageHlsDir } = input;
  const segmentPattern = path.join(stageHlsDir, "seg-%05d.ts");
  const playlistPath = path.join(stageHlsDir, "index.m3u8");

  return [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostdin",
    "-i",
    trackFilePath,
    "-vn",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "44100",
    "-f",
    "hls",
    "-hls_time",
    "3",
    "-hls_list_size",
    "6",
    "-hls_flags",
    "+append_list+omit_endlist+delete_segments",
    "-hls_segment_filename",
    segmentPattern,
    playlistPath,
  ];
}
