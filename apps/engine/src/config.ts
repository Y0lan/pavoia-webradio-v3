// Pure environment-variable parser for the engine.
//
// Reads + validates every config knob the engine needs at startup,
// then hands a fully typed `EngineConfig` to bootstrap. Failures
// produce a structured error list so a misconfigured deploy fails
// fast with every problem listed at once, not one-at-a-time.
//
// All paths are required to be absolute. Plex URL must include a
// scheme + host. The supervisor and Plex client both expect their
// inputs already validated — keeping that responsibility in one
// place makes the boundary explicit.

import path from "node:path";

export interface EngineConfig {
  /** TCP port for the Hono server. Reused from resolvePort in app.ts. */
  port: number;
  /** Plex base URL with scheme + host(+port). e.g. http://127.0.0.1:31711 */
  plexBaseUrl: string;
  /** Plex auth token (X-Plex-Token). Sent as header, never logged. */
  plexToken: string;
  /** Library root the Plex client uses to reject path-traversal. */
  libraryRoot: string;
  /** Parent dir for per-stage HLS output. Each stage writes to
   *  <hlsRoot>/<stageId>/. */
  hlsRoot: string;
  /** Absolute path to the curating fallback file the supervisor uses
   *  for empty playlists / all-tracks-dead. */
  fallbackFile: string;
  /** ffmpeg binary; absolute path or bare name on PATH. */
  ffmpegBin: string;
  /** Plex polling interval in ms. Default 60_000 (per SLIM_V3 §"Audio
   *  engine"). */
  plexPollIntervalMs: number;
}

export type LoadConfigResult =
  | { ok: true; config: EngineConfig }
  | { ok: false; errors: string[] };

const DEFAULT_PORT = 3001;
const DEFAULT_FFMPEG_BIN = "ffmpeg";
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const PORT_PATTERN = /^[1-9]\d{0,4}$/;

export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
): LoadConfigResult {
  const errors: string[] = [];

  const port = parsePort(env.ENGINE_PORT, errors);
  const plexBaseUrl = parseHttpUrl(env.PLEX_BASE_URL, "PLEX_BASE_URL", errors);
  const plexToken = parseRequiredString(env.PLEX_TOKEN, "PLEX_TOKEN", errors);
  const libraryRoot = parseAbsPath(
    env.PLEX_LIBRARY_ROOT,
    "PLEX_LIBRARY_ROOT",
    errors,
  );
  const hlsRoot = parseAbsPath(env.HLS_ROOT, "HLS_ROOT", errors);
  const fallbackFile = parseAbsPath(
    env.FALLBACK_FILE,
    "FALLBACK_FILE",
    errors,
  );
  const ffmpegBin = env.FFMPEG_BIN?.trim() || DEFAULT_FFMPEG_BIN;
  const plexPollIntervalMs = parseIntervalMs(
    env.PLEX_POLL_INTERVAL_MS,
    "PLEX_POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
    errors,
  );

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    config: {
      port: port!,
      plexBaseUrl: plexBaseUrl!,
      plexToken: plexToken!,
      libraryRoot: libraryRoot!,
      hlsRoot: hlsRoot!,
      fallbackFile: fallbackFile!,
      ffmpegBin,
      plexPollIntervalMs,
    },
  };
}

function parsePort(
  raw: string | undefined,
  errors: string[],
): number | undefined {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  if (!PORT_PATTERN.test(raw)) {
    errors.push(
      `ENGINE_PORT must be a plain decimal integer in [1, 65535], got ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 65535) {
    errors.push(
      `ENGINE_PORT must be a plain decimal integer in [1, 65535], got ${JSON.stringify(raw)}`,
    );
    return undefined;
  }
  return parsed;
}

function parseRequiredString(
  raw: string | undefined,
  name: string,
  errors: string[],
): string | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) {
    errors.push(`${name} is required (got ${JSON.stringify(raw)})`);
    return undefined;
  }
  return trimmed;
}

function parseHttpUrl(
  raw: string | undefined,
  name: string,
  errors: string[],
): string | undefined {
  const s = parseRequiredString(raw, name, errors);
  if (s === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    errors.push(`${name} is not a valid URL: ${JSON.stringify(s)}`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    errors.push(
      `${name} must use http:// or https://, got ${JSON.stringify(url.protocol)}`,
    );
    return undefined;
  }
  // Strip trailing slashes for consistency — the Plex client also
  // strips them but doing it here makes config logging predictable.
  return s.replace(/\/+$/, "");
}

function parseAbsPath(
  raw: string | undefined,
  name: string,
  errors: string[],
): string | undefined {
  const s = parseRequiredString(raw, name, errors);
  if (s === undefined) return undefined;
  if (!path.isAbsolute(s)) {
    errors.push(
      `${name} must be an absolute path, got ${JSON.stringify(s)}`,
    );
    return undefined;
  }
  return s;
}

function parseIntervalMs(
  raw: string | undefined,
  name: string,
  defaultMs: number,
  errors: string[],
): number {
  if (raw === undefined || raw === "") return defaultMs;
  if (!/^[1-9]\d*$/.test(raw)) {
    errors.push(
      `${name} must be a positive integer ms, got ${JSON.stringify(raw)}`,
    );
    return defaultMs;
  }
  const n = Number(raw);
  if (n < 1000) {
    errors.push(
      `${name} must be at least 1000ms (1s) to avoid hammering Plex; got ${n}`,
    );
    return defaultMs;
  }
  return n;
}
