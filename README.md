# pavoia-webradio-v3

Plex-driven HLS webradio. Replaces pavoia-webradio (v1, Node+React+MPD) and pavoia-webradio-v2 (Go+Postgres+Redis+Meili+Next.js) with a single coherent foundation.

**Status:** Scaffold only. Week 0 (prototype + verification) complete. Week 1 (engine MVP implementation) starting.

See [`CLAUDE.md`](./CLAUDE.md) for the orientation doc — read this first if starting a new session.

## Docs (source of truth)

- [`docs/SLIM_V3.md`](./docs/SLIM_V3.md) — what ships in v3.0 MVP (canonical feature scope)
- [`docs/WEEK0_LOG.md`](./docs/WEEK0_LOG.md) — 16 locked engineering requirements (A–P) from prototype work
- [`docs/DESIGN_V3.md`](./docs/DESIGN_V3.md) — architecture + Plex audit
- [`docs/ENG_REVIEW_V3.md`](./docs/ENG_REVIEW_V3.md) — pre-impl engineering review + Codex challenge resolution
- [`docs/TODO_V3.md`](./docs/TODO_V3.md) — full feature triage reasoning (reference only)

## Quick structure

```
apps/
  engine/   Node 22 + Hono. 10 stage supervisors, each running one ffmpeg per track.
  web/      Vite SPA (React 19 + TanStack) + Hono static+proxy layer.
packages/
  shared/   Types, stages config, zod schemas, WebSocket event types.
deploy/     (Week 1) cron scripts, watchdog, start wrappers.
docs/       Source-of-truth documents. Do not delete.
```

## Commands

```bash
npm install         # install workspace deps
npm run typecheck   # tsc --build across the monorepo
```

Dev servers, build, deploy, etc. come online during Week 1.
