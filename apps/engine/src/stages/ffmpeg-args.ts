// Pure ffmpeg argv builder for a single stage invocation → HLS output.
//
// Locks WEEK0_LOG reqs (see docs/WEEK0_LOG.md Steps 3/3b):
//   K: one ffmpeg per track (this builder produces one invocation's argv)
//   L: -hls_flags +append_list+omit_endlist+delete_segments,
//      -hls_time 3, -hls_list_size 6 (rolling 18s window, live-like)
//   M: segment filename pattern seg-%05d.ts
//   N: track boundary = ffmpeg exit event — REQUIRES real-time pacing (`-re`)
//      so a 5-minute track takes ~5 real minutes. Without -re, ffmpeg reads
//      the file as fast as disk allows and exits in ~100 ms, which would
//      collapse the rolling-window invariant and gap listeners.
//   O: -stream_loop -1 on the curating.aac fallback so ffmpeg only exits
//      when the supervisor aborts it, giving a stable "curating" state.
//   P: AAC 128 kbps stereo 44.1 kHz, video stream stripped (-vn).
//
// Argument order matters to ffmpeg: global opts → input opts → -i <input>
// → output opts → output file. Breaking that order produces cryptic
// "option not found" / "unable to find a suitable output format" errors.
// See `ffmpeg -h full` > "Main options" for the grammar.

import path from "node:path";

export interface BuildFfmpegArgsInput {
  /** Absolute path to the audio file ffmpeg will read. */
  trackFilePath: string;
  /** Absolute directory where index.m3u8 and seg-*.ts are written. */
  stageHlsDir: string;
  /**
   * When true, wrap the input with `-stream_loop -1` so ffmpeg plays the
   * file on repeat indefinitely. Used for the empty-playlist fallback
   * (Req O). Default: false (single play, exit on EOF).
   */
  loopInput?: boolean;
}

export function buildFfmpegArgs(input: BuildFfmpegArgsInput): string[] {
  const { trackFilePath, stageHlsDir, loopInput = false } = input;
  const segmentPattern = path.join(stageHlsDir, "seg-%05d.ts");
  const playlistPath = path.join(stageHlsDir, "index.m3u8");

  const globalOpts = [
    "-hide_banner",
    "-loglevel",
    "warning",
    // -nostats goes via a separate path than -loglevel in ffmpeg; without
    // it, the encoder still prints `frame=... time=... bitrate=...` every
    // ~500ms on stderr, flooding any downstream log sink.
    "-nostats",
    "-nostdin",
  ];

  const inputOpts = ["-re"];
  if (loopInput) {
    inputOpts.push("-stream_loop", "-1");
  }
  inputOpts.push("-i", trackFilePath);

  const outputOpts = [
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
  ];

  return [...globalOpts, ...inputOpts, ...outputOpts, playlistPath];
}
