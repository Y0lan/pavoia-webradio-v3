// End-to-end audio integrity smoke test for the stage supervisor.
//
// The unit and existing integration tests verify the supervisor's
// lifecycle, argv shape, and that segments APPEAR on disk. This file
// answers a stronger question: does the HLS output actually decode
// back to clean audio across many track boundaries?
//
// Methodology:
//   1. Generate a 5-second silent AAC fixture via lavfi.
//   2. Run the supervisor with that fixture for ~20 s — long enough
//      to force ≥3 ffmpeg respawns and cross the track boundary
//      seam multiple times.
//   3. Stop the supervisor, append #EXT-X-ENDLIST to the m3u8 so the
//      HLS demuxer treats it as a finite stream (supervisor emits
//      with +omit_endlist live profile by design).
//   4. Decode the playlist through ffmpeg to raw Int16 PCM.
//   5. Assert:
//        - max |sample|  < -46 dBFS (the silence fixture should stay
//          silent; any non-zero energy is an encoder/mux artifact).
//        - click count   == 0 (sample-to-sample Δ > 10 % of int16
//          range is by definition a click — the classic failure
//          mode per-track respawn architectures introduce).
//        - duration      in [12, 22] s (rolling 6-segment × 3 s
//          window, with supervisor start/stop slop).
//        - ≥ 3 track boundaries observed via supervisor events.
//
// Skipped automatically when ffmpeg isn't on PATH.
//
// Concurrent-stages test exercises test #3 from the verification
// plan: multiple supervisors run in parallel with distinct hlsDirs
// and independently produce clean output.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Track } from "@pavoia/shared";

import {
  startStage,
  type StageController,
  type StageEvent,
} from "./supervisor.ts";

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
  await execFile("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=44100:cl=stereo",
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

function makeTrack(filePath: string, durationSec: number): Track {
  return {
    plexRatingKey: 1,
    fallbackHash: "0".repeat(16),
    title: "silence",
    artist: "test",
    album: "test",
    albumYear: null,
    durationSec,
    filePath,
    coverUrl: null,
  };
}

interface IntegrityReport {
  samples: number;
  durationSec: number;
  maxAbs: number;
  rms: number;
  maxDelta: number;
  clickCount: number;
  clickThreshold: number;
}

/**
 * Decode the playlist through ffmpeg to mono 16-bit 44.1 kHz PCM,
 * then compute integrity metrics in one pass. The -t cap prevents a
 * hang if the playlist somehow still looks live after we append
 * ENDLIST (belt-and-suspenders for CI).
 */
async function analyzeHls(
  m3u8Path: string,
  clickThresholdFrac: number,
  maxSeconds: number,
): Promise<IntegrityReport> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const ff = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-t",
      String(maxSeconds),
      "-i",
      m3u8Path,
      "-f",
      "s16le",
      "-ac",
      "1",
      "-ar",
      "44100",
      "pipe:1",
    ]);
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.stderr.on("data", () => {});
    ff.on("error", reject);
    ff.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg decode exited ${code}`));
        return;
      }
      const buf = Buffer.concat(chunks);
      // Allocate a fresh ArrayBuffer so byteOffset is guaranteed to
      // be 2-aligned. Buffer.concat may return a slice backed by a
      // pooled ArrayBuffer whose offset isn't aligned — constructing
      // an Int16Array directly from that slice would throw
      // RangeError on some builds.
      const aligned = new Uint8Array(buf);
      const view = new Int16Array(
        aligned.buffer,
        aligned.byteOffset,
        Math.floor(buf.length / 2),
      );
      let maxAbs = 0;
      let maxDelta = 0;
      let clicks = 0;
      let sumSq = 0;
      const threshold = Math.round(32768 * clickThresholdFrac);
      for (let i = 0; i < view.length; i++) {
        const v = view[i]!;
        const a = Math.abs(v);
        if (a > maxAbs) maxAbs = a;
        sumSq += v * v;
        if (i > 0) {
          const d = Math.abs(v - view[i - 1]!);
          if (d > maxDelta) maxDelta = d;
          if (d > threshold) clicks++;
        }
      }
      resolve({
        samples: view.length,
        durationSec: view.length / 44100,
        maxAbs,
        rms: Math.sqrt(sumSq / Math.max(view.length, 1)),
        maxDelta,
        clickCount: clicks,
        clickThreshold: threshold,
      });
    });
  });
}

async function finalizeM3u8(m3u8: string): Promise<void> {
  const body = await readFile(m3u8, "utf8");
  if (!body.includes("#EXT-X-ENDLIST")) {
    await writeFile(m3u8, body + "#EXT-X-ENDLIST\n");
  }
}

describe("audio integrity — real ffmpeg end-to-end", () => {
  it("runs silence through ≥3 track boundaries with zero clicks and a silent floor", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg not on PATH");
      return;
    }

    const work = await mkdtemp(path.join(tmpdir(), "pavoia-audiointeg-"));
    let ctl: StageController | null = null;
    const events: StageEvent[] = [];
    try {
      const fixture = path.join(work, "silence.aac");
      const hlsDir = path.join(work, "hls");
      await writeSilentFixture(fixture, 5);

      ctl = startStage({
        stageId: "integrity",
        tracks: [makeTrack(fixture, 5)],
        hlsDir,
        fallbackFile: fixture,
        onEvent: (e) => events.push(e),
      });

      // 20 s gives ~4 track cycles at 5 s each.
      await new Promise((r) => setTimeout(r, 20_000));
      await ctl.stop();

      const m3u8 = path.join(hlsDir, "index.m3u8");
      await finalizeM3u8(m3u8);
      const report = await analyzeHls(m3u8, 0.1, 30);

      // Silence fixture decoded back: lavfi anullsrc + AAC 128 round-trips
      // to digital zero on this build; -46 dBFS is a very loose ceiling
      // that accommodates any future encoder/dither changes.
      assert.ok(
        report.maxAbs < 32768 * 0.005,
        `silence fixture leaked audio energy: maxAbs=${report.maxAbs} (/32768)`,
      );

      // A 10 %-of-range sample-to-sample jump is a click by any
      // definition. The per-track ffmpeg respawn architecture is
      // the only place this could plausibly arise on silent input.
      assert.equal(
        report.clickCount,
        0,
        `expected 0 clicks, got ${report.clickCount} (maxDelta=${report.maxDelta})`,
      );

      // Decoded duration = playlist rolling window (~18 s) with some
      // slop for supervisor start/stop. Anything drastically shorter
      // would indicate segments going missing.
      assert.ok(
        report.durationSec >= 12 && report.durationSec <= 22,
        `expected ~18s of decoded audio (±slop), got ${report.durationSec.toFixed(2)}s`,
      );

      // Count ONLY natural (ok) exits. track_ended also fires for
      // { kind: "aborted" } when ctl.stop() interrupts the current
      // ffmpeg, which would inflate the count by 1 and could mask a
      // slow CI run producing too few real boundary crossings.
      const boundaries = events.filter(
        (e): e is Extract<StageEvent, { type: "track_ended" }> =>
          e.type === "track_ended" && e.exit.kind === "ok",
      ).length;
      assert.ok(
        boundaries >= 3,
        `expected ≥3 natural track boundaries in 20s, got ${boundaries}`,
      );

      const crashes = events.filter((e) => e.type === "crash").length;
      assert.equal(crashes, 0, `expected 0 crashes, got ${crashes}`);
    } finally {
      if (ctl && ctl.status() !== "stopped")
        await ctl.stop().catch(() => {});
      await rm(work, { recursive: true, force: true });
    }
  });

  it("runs two concurrent supervisors producing independent clean output", async (t) => {
    if (!(await ffmpegAvailable())) {
      t.skip("ffmpeg not on PATH");
      return;
    }

    const work = await mkdtemp(path.join(tmpdir(), "pavoia-audiointeg-"));
    const ctls: StageController[] = [];
    try {
      const fixture = path.join(work, "silence.aac");
      await writeSilentFixture(fixture, 5);

      const hlsDirA = path.join(work, "hls-a");
      const hlsDirB = path.join(work, "hls-b");

      const events: Record<string, StageEvent[]> = { a: [], b: [] };
      ctls.push(
        startStage({
          stageId: "a",
          tracks: [makeTrack(fixture, 5)],
          hlsDir: hlsDirA,
          fallbackFile: fixture,
          onEvent: (e) => events.a!.push(e),
        }),
      );
      ctls.push(
        startStage({
          stageId: "b",
          tracks: [makeTrack(fixture, 5)],
          hlsDir: hlsDirB,
          fallbackFile: fixture,
          onEvent: (e) => events.b!.push(e),
        }),
      );

      await new Promise((r) => setTimeout(r, 20_000));
      await Promise.all(ctls.map((c) => c.stop()));

      for (const dirKey of ["a", "b"] as const) {
        const dir = dirKey === "a" ? hlsDirA : hlsDirB;
        const m3u8 = path.join(dir, "index.m3u8");
        await finalizeM3u8(m3u8);
        const report = await analyzeHls(m3u8, 0.1, 30);

        assert.ok(
          report.maxAbs < 32768 * 0.005,
          `stage ${dirKey} leaked audio energy: maxAbs=${report.maxAbs}`,
        );
        assert.equal(
          report.clickCount,
          0,
          `stage ${dirKey} has clicks: ${report.clickCount} (maxDelta=${report.maxDelta})`,
        );

        // Same guard as above: only clean exits count as real
        // track-boundary crossings. The abort from ctl.stop() would
        // otherwise inflate the count.
        const boundaries = events[dirKey]!.filter(
          (e): e is Extract<StageEvent, { type: "track_ended" }> =>
            e.type === "track_ended" && e.exit.kind === "ok",
        ).length;
        assert.ok(
          boundaries >= 3,
          `stage ${dirKey} produced ${boundaries} natural boundaries, expected ≥3`,
        );
      }
    } finally {
      for (const c of ctls) {
        if (c.status() !== "stopped") await c.stop().catch(() => {});
      }
      await rm(work, { recursive: true, force: true });
    }
  });
});
