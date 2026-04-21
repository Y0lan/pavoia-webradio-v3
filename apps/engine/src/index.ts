// apps/engine entry point.
//
// Boots the Hono app from app.ts on 127.0.0.1:${ENGINE_PORT|3001}, wires
// graceful shutdown for the Whatbox cron-watchdog deploy pattern (Req E,
// Req J): SIGTERM/SIGINT → close server → exit 0 inside 5s, hard exit 1
// after. Bind failures exit 1 so the watchdog sees HTTP 000 and respawns.

import { serve } from "@hono/node-server";
import { createApp, resolvePort } from "./app.ts";

const port = resolvePort(process.env.ENGINE_PORT);
const app = createApp();

const server = serve(
  { fetch: app.fetch, hostname: "127.0.0.1", port },
  ({ address, port }) => {
    console.log(
      `[engine] listening on ${address}:${port} pid=${process.pid} node=${process.version}`,
    );
  },
);

server.on("error", (err) => {
  console.error(`[engine] server error:`, err);
  process.exit(1);
});

const SHUTDOWN_TIMEOUT_MS = 5000;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[engine] received ${signal}, closing server...`);

  const forceExit = setTimeout(() => {
    console.error(
      `[engine] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`,
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    clearTimeout(forceExit);
    if (err) {
      console.error(`[engine] close error:`, err);
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
