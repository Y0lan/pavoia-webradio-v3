// Factory + pure helpers for the engine's HTTP app.
//
// Kept separate from index.ts so tests can exercise the Hono app via
// `app.request()` without binding a port, and so `resolvePort` is
// unit-testable without touching process.env.

import { Hono } from "hono";
import {
  STAGES,
  AUDIO_STAGES,
  toPublicTrack,
  type NowPlaying,
  type Stage,
} from "@pavoia/shared";

import { createHlsHandler } from "./hls.ts";
import { createPlexProxy } from "./plex/proxy.ts";
import type { StageRegistry } from "./stages/registry.ts";
import { createWebStaticHandler } from "./web-static.ts";

export type HealthBody = {
  ok: true;
  plexReachable: null;
  stages: Record<string, never>;
  pid: number;
  uptimeSec: number;
  nodeVersion: string;
  stageCount: { total: number; audio: number };
};

/**
 * Response body for `GET /api/stages`. The static catalog of all 11
 * stages, ordered for the UI sidebar. Live values that can change
 * per Plex playlist (title, summary, current track) are NOT here —
 * `/api/stages/:id/now` exposes those.
 *
 * The `Stage` type from @pavoia/shared has no internal-only fields
 * (no filePath, no token, etc.), so we can serialize it directly
 * without a Pick'd public projection — unlike Track / PublicTrack.
 */
export type StagesBody = {
  stages: Stage[];
};

/**
 * Optional dependencies for the Hono app.
 *
 * - `registry` — when provided, `/api/stages/:id/now` queries it for
 *   live state. When omitted, `/now` returns 503.
 * - `hlsRoot` — when provided, `/hls/*` serves the per-stage HLS
 *   output from there. When omitted, `/hls/*` returns 503 — useful
 *   for HTTP-only canary deploys + the existing shutdown integration
 *   tests.
 */
export interface AppDeps {
  registry?: StageRegistry;
  hlsRoot?: string;
  /** When set, the engine serves the built Vite SPA from this dir
   *  for any path that isn't /api/* or /hls/*. When unset, those
   *  paths return 404 (the local-dev workflow lets Vite serve the
   *  SPA at a different port). */
  webDistDir?: string;
  /** When provided, mounts a narrow read-only Plex API proxy at
   *  /api/plex/* (thumbs + artist info). The proxy attaches the
   *  X-Plex-Token server-side so the browser never sees it. */
  plexProxy?: {
    baseUrl: string;
    token: string;
  };
}

const PORT_PATTERN = /^[1-9]\d{0,4}$/;

export function resolvePort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3001;
  if (!PORT_PATTERN.test(raw)) {
    throw new Error(
      `ENGINE_PORT must be a plain decimal integer in [1, 65535], got ${JSON.stringify(raw)}`,
    );
  }
  const parsed = Number(raw);
  if (parsed < 1 || parsed > 65535) {
    throw new Error(
      `ENGINE_PORT must be a plain decimal integer in [1, 65535], got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

export function createApp(deps: AppDeps = {}): Hono {
  const { registry, hlsRoot, webDistDir, plexProxy } = deps;
  const app = new Hono();

  app.get("/api/health", (c) => {
    const body: HealthBody = {
      ok: true,
      plexReachable: null,
      stages: {},
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      stageCount: { total: STAGES.length, audio: AUDIO_STAGES.length },
    };
    return c.json(body);
  });

  app.get("/api/stages", (c) => {
    const body: StagesBody = { stages: STAGES };
    return c.json(body);
  });

  app.get("/api/stages/:id/now", (c) => {
    const id = c.req.param("id");

    // Validate the stage id is one of the known catalog ids before
    // we touch the registry. Returns 404 with the offending id so
    // clients (and curl debug) get a useful message.
    const stage = STAGES.find((s) => s.id === id);
    if (stage === undefined) {
      return c.json({ error: "stage_not_found", stageId: id }, 404);
    }

    // Bus is the no-audio easter egg. There's no supervisor and no
    // HLS stream — the UI handles it as a card-only overlay. Return
    // 410 Gone so a client that mistakenly requests its now-playing
    // doesn't think it's a transient error.
    if (stage.disabled) {
      return c.json({ error: "stage_has_no_audio", stageId: id }, 410);
    }

    if (registry === undefined) {
      // Engine running without a registry yet — `/api/stages` works
      // (static catalog) but live state isn't available. 503 = "not
      // ready" so a watchdog/restart doesn't escalate.
      return c.json(
        { error: "registry_unavailable", stageId: id },
        503,
      );
    }

    const controller = registry.get(id);
    if (controller === undefined) {
      // Catalog says the stage exists, but no supervisor is running
      // for it. Same not-ready signal — `index.ts` may still be
      // bringing the stage up.
      return c.json(
        { error: "stage_not_running", stageId: id },
        503,
      );
    }

    const snap = controller.snapshot();
    const body: NowPlaying = {
      stageId: stage.id,
      status: snap.status,
      track: snap.track === null ? null : toPublicTrack(snap.track),
      startedAt: snap.trackStartedAt,
      streamUrl: `/hls/${stage.id}/index.m3u8`,
    };
    return c.json(body);
  });

  // /hls/*  — per-stage HLS output (m3u8 + segments). When hlsRoot
  // isn't wired (HTTP-only canary), fall through to a 503 sentinel
  // WITH the same CORS header the real handler returns — otherwise
  // browsers in the canary scenario see opaque CORS failure instead
  // of an actionable 503.
  if (hlsRoot !== undefined) {
    app.route(
      "/hls",
      createHlsHandler({
        hlsRoot,
        ...(registry !== undefined ? { registry } : {}),
      }),
    );
  } else {
    app.all("/hls/*", (c) => {
      c.header("access-control-allow-origin", "*");
      return c.json({ error: "hls_unavailable" }, 503);
    });
  }

  // /api/plex/* — narrow Plex media proxy (thumbs + artist info).
  // Mounted BEFORE the catchall so /api/plex/<typo> still gets a
  // JSON 404 from the namespace catchall below. When plexProxy isn't
  // wired (HTTP-only canary deploys), unknown /api/plex/* returns
  // the namespace 404.
  if (plexProxy !== undefined) {
    app.route("/api/plex", createPlexProxy(plexProxy));
  }

  // Reserve the /api namespace with an explicit JSON 404 BEFORE the
  // SPA catchall takes over. Without this, an unknown /api/<typo>
  // would land in the SPA's `*` handler and return `200 text/html`,
  // which makes frontend bugs (and curl debugging) confusing — the
  // operator expects JSON for everything under /api. /hls already
  // returns 404 JSON via createHlsHandler's own notFound handler.
  app.all("/api/*", (c) =>
    c.json({ error: "not_found", path: c.req.path }, 404),
  );

  // SPA catchall — built Vite output (non-/api, non-/hls paths).
  // Mounted last so /api and /hls take precedence. When webDistDir
  // isn't set we keep the JSON not_found behavior for unknown paths
  // (local dev with separate Vite server).
  if (webDistDir !== undefined) {
    app.route("/", createWebStaticHandler({ distDir: webDistDir }));
  }

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  app.onError((err, c) => {
    console.error(`[engine] request error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}

