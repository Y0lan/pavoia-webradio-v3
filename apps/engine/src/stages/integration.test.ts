// End-to-end smoke test for the stage supervisor against a real ffmpeg.
//
// Skipped automatically when ffmpeg isn't on PATH (dev machines without
// it, or CI environments that haven't installed it). When ffmpeg is
// available, this is the only test that catches invalid argv combos the
// unit tests can't — ffmpeg refusing a flag, a typo in the HLS output
// format name, segments not actually appearing on disk, etc.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  execFile as execFileCb,
  type ExecFileException,
} from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Track } from "@pavoia/shared";

import { startStage, type StageEvent } from "./supervisor.ts";

const execFile = promisify(execFileCb);

async function ffmpegAvailable(): Promise<boolean> {
  try {
    await execFile("ffmpeg", ["-version"]);
    return true;
  } catch {
    return false;
  }
}

async function writeSilentFixture(
  dest: string,
  durationSec: number,
): Promise<void> {
  // lavfi generates silence without needing an input file. AAC 128/44.1/stereo
  // matches the stage encoding exactly, so no resampling stage is needed in
  // the supervisor's ffmpeg — keeps the test fast.
  await execFile("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=44100:cl=stereo`,
    "-t",
    String(durationSec),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-y",
    dest,
  ]);
}

function makeTrack(filePath: string): Track {
  return {
    plexRatingKey: 1,
    fallbackHash: "integration-test00",
    title: "silence",
    artist: "test",
    album: "test",
    albumYear: null,
    durationSec: 4,
    filePath,
    coverUrl: null,
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 100,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("integration: real ffmpeg", () => {
  it("produces an m3u8 and at least one segment from a real audio file", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg not available on PATH — integration test skipped");
      return;
    }

    const work = await mkdtemp(path.join(tmpdir(), "pavoia-integ-"));
    try {
      const fixture = path.join(work, "silence.aac");
      const hlsDir = path.join(work, "hls");
      await writeSilentFixture(fixture, 4);

      const events: StageEvent[] = [];
      const stderrLines: string[] = [];

      const ctl = startStage({
        stageId: "integration",
        tracks: [makeTrack(fixture)],
        hlsDir,
        fallbackFile: fixture,
        onEvent: (e) => events.push(e),
        onStderrLine: (l) => stderrLines.push(l),
      });

      // First segment appears ~3s in (-hls_time 3) when ffmpeg runs with -re.
      // Allow up to 10s to be resilient on slow CI runners.
      await waitFor(
        async () => {
          try {
            const entries = await readdir(hlsDir);
            return (
              entries.includes("index.m3u8") &&
              entries.some((e) => /^seg-\d+\.ts$/.test(e))
            );
          } catch {
            return false;
          }
        },
        10_000,
      );

      const entries = await readdir(hlsDir);
      assert.ok(
        entries.includes("index.m3u8"),
        `m3u8 missing; dir=${entries.join(",")}`,
      );
      const segments = entries.filter((e) => /^seg-\d+\.ts$/.test(e));
      assert.ok(
        segments.length >= 1,
        `expected >=1 segment; got ${segments.length}`,
      );

      // A segment file must have non-zero size.
      if (segments[0]) {
        const segStat = await stat(path.join(hlsDir, segments[0]));
        assert.ok(segStat.size > 0, "segment file is empty");
      }

      // m3u8 must advertise the HLS flags we set.
      const m3u8 = await readFile(path.join(hlsDir, "index.m3u8"), "utf8");
      assert.match(m3u8, /#EXTM3U/);
      assert.match(m3u8, /#EXT-X-TARGETDURATION/);

      await ctl.stop();
      assert.equal(ctl.status(), "stopped");
    } catch (err) {
      // Surface ffmpeg stderr to make CI failures diagnosable.
      const cause = err as ExecFileException & { stderr?: string };
      if (cause?.stderr) {
        process.stderr.write(`ffmpeg stderr:\n${cause.stderr}\n`);
      }
      throw err;
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it("cleans the HLS dir on startup, removing stale segments", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg not available on PATH");
      return;
    }

    const work = await mkdtemp(path.join(tmpdir(), "pavoia-integ-"));
    try {
      const fixture = path.join(work, "silence.aac");
      const hlsDir = path.join(work, "hls");
      await writeSilentFixture(fixture, 4);

      // Pre-seed stale files that must be cleaned.
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(hlsDir, { recursive: true });
      await writeFile(path.join(hlsDir, "seg-99999.ts"), "stale");
      await writeFile(path.join(hlsDir, "index.m3u8"), "#EXTM3U\n# stale\n");

      const ctl = startStage({
        stageId: "clean",
        tracks: [makeTrack(fixture)],
        hlsDir,
        fallbackFile: fixture,
      });

      // After startup, seg-99999.ts must be gone (clean ran before spawn).
      await waitFor(
        async () => {
          try {
            const entries = await readdir(hlsDir);
            return !entries.includes("seg-99999.ts");
          } catch {
            return false;
          }
        },
        5000,
      );
      const entries = await readdir(hlsDir);
      assert.ok(!entries.includes("seg-99999.ts"), "stale segment not cleaned");

      await ctl.stop();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
});
