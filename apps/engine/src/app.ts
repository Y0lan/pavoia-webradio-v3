// Factory + pure helpers for the engine's HTTP app.
//
// Kept separate from index.ts so tests can exercise the Hono app via
// `app.request()` without binding a port, and so `resolvePort` is
// unit-testable without touching process.env.

import { Hono } from "hono";
import { STAGES, AUDIO_STAGES, type Stage } from "@pavoia/shared";

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
 * those land in `/api/stages/:id/now` once the supervisor registry
 * is wired in (later Task 5 slice).
 *
 * The `Stage` type from @pavoia/shared has no internal-only fields
 * (no filePath, no token, etc.), so we can serialize it directly
 * without a Pick'd public projection — unlike Track / PublicTrack.
 */
export type StagesBody = {
  stages: Stage[];
};

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

export function createApp(): Hono {
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

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  app.onError((err, c) => {
    console.error(`[engine] request error on ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "internal_server_error" }, 500);
  });

  return app;
}

