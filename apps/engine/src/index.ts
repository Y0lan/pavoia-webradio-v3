// apps/engine entry point.
//
// Boots the engine on 127.0.0.1:${ENGINE_PORT|3001}, wires graceful
// shutdown for the Whatbox cron-watchdog deploy pattern (Req E, Req J):
// SIGTERM/SIGINT/SIGHUP → stop poller → stop every supervisor → close
// server → exit 0 inside 5 s, hard exit 1 after. Bind failures and
// config validation failures exit 1 so the watchdog sees HTTP 000 and
// respawns.

import { serve } from "@hono/node-server";

import { createApp, resolvePort } from "./app.ts";
import { bootstrap } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";

const SHUTDOWN_TIMEOUT_MS = 5000;

// Escape hatch: skip the per-stage Plex+ffmpeg bootstrap and run the
// engine with only the static HTTP surface (/api/health, /api/stages
// catalog). Useful for:
//   - the shutdown integration tests (signals don't need Plex).
//   - HTTP-only canary deploys where you want to verify the engine
//     boots, binds, and serves /api/health before pointing it at Plex.
//   - Local dev iterations on app.ts that don't need ffmpeg.
const stagesDisabled = process.env.ENGINE_DISABLE_STAGES === "true";

let port: number;
let app: import("hono").Hono;
let shutdownEngine: () => Promise<void>;

if (stagesDisabled) {
  console.log(`[engine] ENGINE_DISABLE_STAGES=true — running HTTP-only`);
  port = resolvePort(process.env.ENGINE_PORT);
  app = createApp(); // no registry → /api/stages/:id/now returns 503
  shutdownEngine = async () => {};
} else {
  const cfgResult = loadConfig(process.env);
  if (!cfgResult.ok) {
    console.error(`[engine] config validation failed:`);
    for (const err of cfgResult.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  const config = cfgResult.config;
  const booted = await bootstrap({ config });
  port = config.port;
  app = booted.app;
  shutdownEngine = booted.shutdown;
}

const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port },
  ({ address, port: boundPort }) => {
    console.log(
      `[engine] listening on ${address}:${boundPort} pid=${process.pid} node=${process.version}`,
    );
  },
);

server.on("error", (err) => {
  console.error(`[engine] server error:`, err);
  process.exit(1);
});

let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[engine] received ${signal}, stopping stages + server...`);

  const forceExit = setTimeout(() => {
    console.error(
      `[engine] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  // Stop the engine subsystems first (poller + supervisors), then
  // close the HTTP server. Order matters: a supervisor might still
  // be writing to the HLS dir while the server is happily serving
  // 200s — fine to flip them off in parallel, but we want graceful
  // ffmpeg SIGTERM to finish before exit so segments aren't half-
  // written.
  Promise.allSettled([
    shutdownEngine(),
    new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  ])
    .then((results) => {
      clearTimeout(forceExit);
      const failures = results
        .filter((r) => r.status === "rejected")
        .map((r) => (r as PromiseRejectedResult).reason);
      if (failures.length > 0) {
        for (const f of failures)
          console.error(`[engine] shutdown error:`, f);
        process.exit(1);
      }
      console.log(`[engine] shutdown complete`);
      process.exit(0);
    });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGHUP", () => shutdown("SIGHUP"));

process.on("uncaughtException", (err) => {
  console.error(`[engine] uncaughtException:`, err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[engine] unhandledRejection:`, reason);
  process.exit(1);
});
