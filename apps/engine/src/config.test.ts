import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "./config.ts";

const MIN_VALID = {
  PLEX_BASE_URL: "http://127.0.0.1:31711",
  PLEX_TOKEN: "tok",
  PLEX_LIBRARY_ROOT: "/home/yolan/files/plex_music_library/opus",
  HLS_ROOT: "/dev/shm/1008/radio-hls",
  FALLBACK_FILE: "/home/yolan/curating.aac",
} as const;

describe("loadConfig — happy path", () => {
  it("returns a fully populated config when every required var is set", () => {
    const r = loadConfig(MIN_VALID);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.port, 3001); // default
    assert.equal(r.config.plexBaseUrl, "http://127.0.0.1:31711");
    assert.equal(r.config.plexToken, "tok");
    assert.equal(r.config.libraryRoot, MIN_VALID.PLEX_LIBRARY_ROOT);
    assert.equal(r.config.hlsRoot, MIN_VALID.HLS_ROOT);
    assert.equal(r.config.fallbackFile, MIN_VALID.FALLBACK_FILE);
    assert.equal(r.config.ffmpegBin, "ffmpeg"); // default
    assert.equal(r.config.plexPollIntervalMs, 60_000); // default
  });

  it("strips trailing slashes from PLEX_BASE_URL", () => {
    const r = loadConfig({ ...MIN_VALID, PLEX_BASE_URL: "http://x:1///" });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.plexBaseUrl, "http://x:1");
  });

  it("accepts custom FFMPEG_BIN, ENGINE_PORT, and PLEX_POLL_INTERVAL_MS", () => {
    const r = loadConfig({
      ...MIN_VALID,
      ENGINE_PORT: "8080",
      FFMPEG_BIN: "/usr/local/bin/ffmpeg",
      PLEX_POLL_INTERVAL_MS: "30000",
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.config.port, 8080);
    assert.equal(r.config.ffmpegBin, "/usr/local/bin/ffmpeg");
    assert.equal(r.config.plexPollIntervalMs, 30_000);
  });

  it("trims whitespace from FFMPEG_BIN, falling back to default when empty", () => {
    const r = loadConfig({ ...MIN_VALID, FFMPEG_BIN: "   " });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.ffmpegBin, "ffmpeg");
  });
});

describe("loadConfig — failure modes", () => {
  it("collects every error in one pass (not just the first)", () => {
    const r = loadConfig({}); // every required var missing
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.ok(
      r.errors.length >= 5,
      `expected ≥5 errors, got ${r.errors.length}: ${r.errors.join("; ")}`,
    );
    assert.ok(r.errors.some((e) => e.includes("PLEX_BASE_URL")));
    assert.ok(r.errors.some((e) => e.includes("PLEX_TOKEN")));
    assert.ok(r.errors.some((e) => e.includes("PLEX_LIBRARY_ROOT")));
    assert.ok(r.errors.some((e) => e.includes("HLS_ROOT")));
    assert.ok(r.errors.some((e) => e.includes("FALLBACK_FILE")));
  });

  it("rejects a non-http(s) PLEX_BASE_URL", () => {
    const r = loadConfig({ ...MIN_VALID, PLEX_BASE_URL: "ftp://x" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("PLEX_BASE_URL")));
    }
  });

  it("rejects a non-URL PLEX_BASE_URL", () => {
    const r = loadConfig({ ...MIN_VALID, PLEX_BASE_URL: "not a url" });
    assert.equal(r.ok, false);
  });

  it("rejects a relative LIBRARY_ROOT / HLS_ROOT / FALLBACK_FILE", () => {
    for (const v of ["PLEX_LIBRARY_ROOT", "HLS_ROOT", "FALLBACK_FILE"]) {
      const r = loadConfig({ ...MIN_VALID, [v]: "relative/path" });
      assert.equal(r.ok, false, `${v} must reject relative paths`);
    }
  });

  it("rejects a whitespace-only PLEX_TOKEN", () => {
    const r = loadConfig({ ...MIN_VALID, PLEX_TOKEN: "   " });
    assert.equal(r.ok, false);
  });

  it("rejects a non-numeric ENGINE_PORT", () => {
    const r = loadConfig({ ...MIN_VALID, ENGINE_PORT: "abc" });
    assert.equal(r.ok, false);
  });

  it("rejects an out-of-range ENGINE_PORT", () => {
    const r = loadConfig({ ...MIN_VALID, ENGINE_PORT: "99999" });
    assert.equal(r.ok, false);
  });

  it("rejects a sub-1s PLEX_POLL_INTERVAL_MS to avoid hammering Plex", () => {
    const r = loadConfig({
      ...MIN_VALID,
      PLEX_POLL_INTERVAL_MS: "500",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.errors.some((e) => e.includes("at least 1000ms")));
    }
  });

  it("rejects a non-numeric PLEX_POLL_INTERVAL_MS", () => {
    const r = loadConfig({
      ...MIN_VALID,
      PLEX_POLL_INTERVAL_MS: "abc",
    });
    assert.equal(r.ok, false);
  });

  it("rejects PLEX_POLL_INTERVAL_MS above Node's setInterval cap (would silently clamp to 1ms)", () => {
    const r = loadConfig({
      ...MIN_VALID,
      // 2^31 — one above the max int32 setInterval accepts.
      PLEX_POLL_INTERVAL_MS: "2147483648",
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(
        r.errors.some((e) => e.includes("setInterval cap")),
        `expected error mentioning setInterval cap; got ${r.errors.join("; ")}`,
      );
    }
  });

  it("accepts PLEX_POLL_INTERVAL_MS exactly at Node's setInterval cap", () => {
    const r = loadConfig({
      ...MIN_VALID,
      PLEX_POLL_INTERVAL_MS: "2147483647",
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.config.plexPollIntervalMs, 2147483647);
  });
});
