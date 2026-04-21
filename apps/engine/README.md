# @pavoia/engine

The audio engine for Pavoia Webradio v3. Polls Plex playlists, spawns one ffmpeg process per track, emits a continuous HLS stream per stage to `/dev/shm/1008/radio-hls/<stage>/`, and exposes now-playing state over HTTP.

See `../../docs/SLIM_V3.md` for the full feature scope, `../../docs/WEEK0_LOG.md` for the 16 locked requirements (A–P) that constrain the implementation, and `../../CLAUDE.md` at the repo root for onboarding.

## Status

**Week 1 Task 1 — complete.** The engine bootstraps a Hono HTTP server with `/api/health` and graceful shutdown. No Plex client, no ffmpeg, no stage supervisor, no WebSocket hub, no HLS static handler yet — those land in Task 2 onward.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Runs `tsc --build --watch packages/shared` and `node --watch --experimental-strip-types src/index.ts` concurrently (via `concurrently`), so editing shared types hot-rebuilds before engine picks them up. |
| `npm run build` | Compiles `src/**` to `dist/` (test files excluded via `tsconfig.json`). |
| `npm start` | Runs the compiled `dist/index.js`. Production entry point. |
| `npm test` | Rebuilds shared, then runs `node --test --test-reporter=spec` against every `src/**/*.test.ts` file (enumerated by `find`, not a shell glob — reliable across shells and CI). |
| `npm run clean` | Removes `dist/` and `tsconfig.tsbuildinfo`. |

Typecheck runs from the repo root: `npm run typecheck` — which invokes `tsc --build` (source + declarations) **and** `tsc --noEmit -p apps/engine/tsconfig.test.json` (typechecks test files without polluting `dist/`).

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `ENGINE_PORT` | `3001` | Must match `/^[1-9]\d{0,4}$/` and be `≤ 65535`. Rejects scientific (`1e3`), hex (`0x7D9`), octal (`0o5731`), binary (`0b…`), signed (`+3001`, `-3001`), leading-zero (`03001`), numeric-separator (`1_000`), non-ASCII digits (`٣٠٠١`, `３００１`), whitespace-wrapped values (`" 3001"`), floats, `NaN`, `Infinity` and empty/whitespace-only strings. Bad values throw before the server binds so the watchdog sees a dead process (HTTP 000) and respawns. |

Plex token, library paths, and Last.fm keys live in `~/.config/radio/env` on Whatbox (sourced by the wrapper scripts per WEEK0_LOG.md Req G) and are **not** read in Task 1.

## HTTP contract

### `GET /api/health`

Always `200 OK` while the process is alive. Returns:

```json
{
  "ok": true,
  "plexReachable": null,
  "stages": {},
  "pid": 12345,
  "uptimeSec": 87,
  "nodeVersion": "v22.22.2",
  "stageCount": { "total": 11, "audio": 10 }
}
```

`plexReachable` and `stages` are placeholder-shaped and will be filled by Task 2 (Plex client) and Task 3 (stage supervisor). The watchdog (`deploy/bin/watchdog.sh`, Req J) only cares that the endpoint returns any 2xx — **it does not parse the body**. Restart trigger is three consecutive `HTTP 000` responses.

### `404 Not Found`

Any unmatched route:

```json
{ "error": "not_found", "path": "/whatever" }
```

### `500 Internal Server Error`

Thrown exceptions inside a handler are caught by `app.onError`. Response body never contains the exception message or stack; those are logged server-side:

```json
{ "error": "internal_server_error" }
```

## Process lifecycle

Two axes matter for the watchdog contract (Req J): **connection failure** (HTTP 000) triggers a restart after three consecutive ticks; **5xx** means alive-but-degraded and must *not* trigger a restart (so diagnostic state is preserved).

- **Bind failure** (e.g. `EADDRINUSE`) → `server.on('error')` logs `[engine] server error: …`, `process.exit(1)`. No listener → next watchdog tick sees `HTTP 000`. Three ticks → respawn. ✔ Correct restart.
- **`SIGTERM` / `SIGINT` / `SIGHUP`** → `server.close()` stops accepting new connections, waits up to **5 s** for in-flight requests to finish, `process.exit(0)`. After 5 s we hard-exit `1`. Idempotent: a second signal while already shutting down is ignored.
- **Thrown exception inside a Hono route handler** → caught by `app.onError`, returns `500 {"error":"internal_server_error"}`. Watchdog sees 2xx-or-5xx (not `000`), does **not** restart. Server stays alive so the next request can succeed and logs retain context. ✔ Matches Req J.
- **`uncaughtException` / `unhandledRejection`** (bugs outside a route — e.g. in the stage supervisor once it lands) → log and `process.exit(1)`. These signal genuinely unknown state; continuing would be unsafe.

This matches the Whatbox deploy pattern in WEEK0_LOG.md Step 2 — `@reboot` cron starts the engine via `nohup`, `* * * * *` cron pings `/api/health`, any 3-tick connection failure triggers `kill $(cat engine.pid)` + respawn.

## Source layout

```
src/
├── app.ts            # createApp(), resolvePort() — pure, no side effects on import
├── app.test.ts       # unit tests for resolvePort and the HTTP contract (via app.request())
├── shutdown.test.ts  # integration tests: spawn the real entry point, send signals, verify exit codes
└── index.ts          # entry point: resolves port, creates app, serves, wires signals
```

`app.ts` has **no top-level side effects**, so unit tests import it freely without a port bind. `index.ts` does the binding and signal wiring; it is exercised by `shutdown.test.ts` which spawns it as a child process and sends real signals — so the shutdown path is actually tested end-to-end, not just reasoned about.

## Deferred

Coming in later Week 1 tasks:

- **Task 2** — `src/plex/` Plex client (`fetchPlaylist(ratingKey): Promise<Track[]>`).
- **Task 3** — `src/stages/` per-stage supervisor, one ffmpeg per track (Reqs K–P).
- **Task 4** — verify HLS in a real browser (hls.js) + VLC.
- **Task 5** — `/api/stages`, `/api/stages/:id/now`, `/hls/*` static handler.
- **Task 6** — `deploy/bin/start-engine.sh`, cron entries, watchdog port from v2.
- **Task 7** — ship to `v3.nicemouth.box.ca`.
