// apps/web entry point.
//
// Web responsibilities (per docs/SLIM_V3.md + docs/WEEK0_LOG.md):
//   - Serve the built Vite SPA (React 19 + TanStack Router + Query + Tailwind 4)
//   - Proxy /api/* to apps/engine
//   - Serve /hls/:stage/* statically from /dev/shm/1008/radio-hls/
//   - Proxy WebSocket from engine to browser clients
//
// Week 1 starts here. See docs/CLAUDE.md for the sequencing.

import { STAGES } from "@pavoia/shared";

console.log(`pavoia-webradio-v3 web (placeholder)`);
console.log(`Stages: ${STAGES.map((s) => s.id).join(", ")}`);
console.log(`Week 1 implementation not started.`);
