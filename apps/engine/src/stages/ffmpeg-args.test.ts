import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildFfmpegArgs } from "./ffmpeg-args.ts";

const FIXTURE = {
  trackFilePath: "/home/yolan/files/plex_music_library/opus/artist/track.opus",
  stageHlsDir: "/dev/shm/1008/radio-hls/opening",
} as const;

function pairValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("buildFfmpegArgs", () => {
  it("feeds -i with the track's absolute path", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(pairValue(args, "-i"), FIXTURE.trackFilePath);
  });

  it("locks AAC 128 kbps stereo 44.1 kHz and strips video", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.ok(args.includes("-vn"), "-vn must be present");
    assert.equal(pairValue(args, "-c:a"), "aac");
    assert.equal(pairValue(args, "-b:a"), "128k");
    assert.equal(pairValue(args, "-ac"), "2");
    assert.equal(pairValue(args, "-ar"), "44100");
  });

  it("emits HLS with -hls_time 3 and -hls_list_size 6", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(pairValue(args, "-f"), "hls");
    assert.equal(pairValue(args, "-hls_time"), "3");
    assert.equal(pairValue(args, "-hls_list_size"), "6");
  });

  it("sets -hls_flags to the exact rolling-window combo", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(
      pairValue(args, "-hls_flags"),
      "+append_list+omit_endlist+delete_segments",
    );
  });

  it("writes segments as seg-%05d.ts inside stageHlsDir", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(
      pairValue(args, "-hls_segment_filename"),
      path.join(FIXTURE.stageHlsDir, "seg-%05d.ts"),
    );
  });

  it("places the m3u8 playlist as the final argv element", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(
      args.at(-1),
      path.join(FIXTURE.stageHlsDir, "index.m3u8"),
    );
  });

  it("starts with quiet / non-interactive banner flags", () => {
    const args = buildFfmpegArgs(FIXTURE);
    assert.equal(args[0], "-hide_banner");
    assert.equal(pairValue(args, "-loglevel"), "warning");
    assert.ok(args.includes("-nostdin"), "-nostdin must be present");
  });

  it("passes paths through verbatim (argv, not shell — no escaping)", () => {
    const args = buildFfmpegArgs({
      trackFilePath: "/music/weird path/with 'quotes' & spaces/track.flac",
      stageHlsDir: "/dev/shm/1008/radio-hls/opening",
    });
    assert.equal(
      pairValue(args, "-i"),
      "/music/weird path/with 'quotes' & spaces/track.flac",
    );
  });

  it("produces a single contiguous argv with no undefined / empty entries", () => {
    const args = buildFfmpegArgs(FIXTURE);
    for (const [idx, v] of args.entries()) {
      assert.equal(typeof v, "string", `argv[${idx}] must be string`);
      assert.notEqual(v, "", `argv[${idx}] must be non-empty`);
    }
  });
});
