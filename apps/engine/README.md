# @pavoia/engine

The audio engine for Pavoia Webradio v3. It boots a Hono HTTP server, exposes `/api/health` for the cron watchdog, implements graceful SIGTERM / SIGINT / SIGHUP shutdown, fetches stage playlists from Plex, and runs a per-stage ffmpeg supervisor that emits HLS to `/dev/shm/1008/radio-hls/<stage>/`. Now-playing endpoints and WebSocket hub are added in later Week 1 tasks.

See `../../docs/SLIM_V3.md` for the full feature scope, `../../docs/WEEK0_LOG.md` for the 16 locked requirements (A–P) that constrain the implementation, and `../../CLAUDE.md` at the repo root for onboarding.

## Status

**Week 1 Tasks 1–5 — complete.** The engine bootstraps the HTTP server (Task 1), has a Plex playlist client with validation + pagination (Task 2), runs a per-stage ffmpeg supervisor with crash restart, fallback, preflight, TTL'd dead tracks, first-segment watchdog, and queue-don't-restart Plex updates (Task 3 + hardening), is verified click-free end-to-end against real ffmpeg (Task 4), and now exposes the full read-side API + `/hls/*` static handler — `GET /api/stages` + `GET /api/stages/:id/now` + `GET /hls/<stageId>/index.m3u8` + `GET /hls/<stageId>/seg-NNNNN.ts` — driven by a Plex client + N supervisors at startup, a 60 s polling loop that queues track changes, parallel startup fetches, and a liveness watcher that revives supervisors that die unexpectedly (Task 5). What's missing for v3.0 MVP: WebSocket hub for `track_changed` events (UI optimization, the REST `/now` endpoint already covers polling), and `deploy/bin/*` scripts (Task 6).

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

Validated by `loadConfig` in `src/config.ts`. Every error is collected in one pass so a misconfigured deploy fails fast with the full punch list.

| Var | Default | Notes |
|---|---|---|
| `ENGINE_PORT` | `3001` | Must match `/^[1-9]\d{0,4}$/` and be `≤ 65535`. Rejects scientific (`1e3`), hex (`0x7D9`), octal (`0o5731`), binary (`0b…`), signed (`+3001`, `-3001`), leading-zero (`03001`), numeric-separator (`1_000`), non-ASCII digits (`٣٠٠١`, `３００１`), whitespace-wrapped values (`" 3001"`), floats, `NaN`, `Infinity` and empty/whitespace-only strings. Bad values exit 1 before bind so the watchdog sees HTTP 000 and respawns. |
| `PLEX_BASE_URL` | — *(required)* | `http://` or `https://`, e.g. `http://127.0.0.1:31711`. Trailing slashes stripped. |
| `PLEX_TOKEN` | — *(required)* | Plex auth token (`X-Plex-Token`). Sent as header, never logged. |
| `PLEX_LIBRARY_ROOT` | — *(required)* | Absolute path. Plex client rejects any track whose `Part.file` resolves outside this dir (Req D). |
| `HLS_ROOT` | — *(required)* | Absolute path; per-stage HLS lands at `<HLS_ROOT>/<stageId>/`. Whatbox prod: `/dev/shm/1008/radio-hls`. |
| `FALLBACK_FILE` | — *(required)* | Absolute path to the curating loop file. Preflighted at supervisor start; broken fallback exits the stage cleanly. |
| `FFMPEG_BIN` | `ffmpeg` | Absolute path or bare name on PATH. |
| `PLEX_POLL_INTERVAL_MS` | `60000` | How often the poller refreshes each stage's playlist. Min 1000 (rejects sub-1s to avoid hammering Plex). |
| `ENGINE_DISABLE_STAGES` | unset | Set to `true` to boot in HTTP-only mode: skips Plex client + supervisors entirely, `/api/stages/:id/now` returns 503. Useful for canary deploys and shutdown integration tests. |

Whatbox sources these from `~/.config/radio/env` via the deploy wrapper scripts (Req G).

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

### `GET /api/stages`

The static catalog of all 11 stages from `@pavoia/shared`, ordered for the UI sidebar:

```json
{ "stages": [ { "id": "opening", "order": 1, "plexPlaylistId": 162337, "icon": "🌄", "fallbackTitle": "Opening", "...": "..." }, ... ] }
```

### `GET /api/stages/:id/now`

Live now-playing for a single stage:

```json
{
  "stageId": "opening",
  "status": "playing",
  "track": { "plexRatingKey": 12345, "title": "...", "artist": "...", "...": "..." },
  "startedAt": 1761225600000,
  "streamUrl": "/hls/opening/index.m3u8"
}
```

Status codes:

| Code | When |
|---|---|
| `200` | Known stage with a registered controller. `track` and `startedAt` are `null` while `status` is `curating`, `starting`, `stopping`, or `stopped`. |
| `404` | `stage_not_found` — id not in the static catalog. |
| `410` | `stage_has_no_audio` — the `bus` mystery stage by design. |
| `503` | `registry_unavailable` (engine in HTTP-only mode) or `stage_not_running` (no controller registered yet — bootstrap may still be coming up). |

The `Track` is projected via `toPublicTrack` so the engine-internal `filePath` cannot leak.

### `GET /hls/:stageId/index.m3u8` and `GET /hls/:stageId/seg-NNNNN.ts`

Static HLS files written by the per-stage ffmpeg into `<HLS_ROOT>/<stageId>/`. The path-traversal guard validates `stageId` against the static catalog and `filename` against an exact regex (`index.m3u8` or `seg-\d+\.ts`) BEFORE composing the on-disk path; a redundant resolved-path-stays-inside-stageDir check catches future regressions.

Headers tuned for hls.js + native iOS Safari:

| File | `Content-Type` | `Cache-Control` |
|---|---|---|
| `index.m3u8` | `application/vnd.apple.mpegurl` | `no-cache, no-store, must-revalidate` (live profile, rewritten every 3 s) |
| `seg-NNNNN.ts` | `video/mp2t` | `public, max-age=10` (NOT immutable — URLs re-bind to different bytes after engine restart since `seg-%05d.ts` numbering resets at 00000) |

`Access-Control-Allow-Origin: *` on every response — public radio, no credentials.

Status codes:

| Code | When |
|---|---|
| `200` | Known stage with controller in `playing`/`curating` + valid filename + file present + not a symlink |
| `400` | `path_traversal` (resolved path escapes the stage dir) / `symlink_rejected` |
| `404` | `stage_not_found` / `bad_filename` / `file_not_found` / `not_a_file` |
| `410` | `stage_has_no_audio` (the `bus` mystery stage) |
| `503` | `hls_unavailable` (engine in HTTP-only mode) / `stage_not_running` (controller missing or in `starting`/`stopping`/`stopped`) |

Symlinks inside `HLS_ROOT` are **rejected** (lstat detects them before stat would silently follow). Defense-in-depth even though the operator owns the tmpfs.

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
- **`SIGTERM` / `SIGINT` / `SIGHUP`** → `server.close()` stops accepting new connections, every supervisor's `stop()` runs in parallel, then `process.exit(0)`. The whole shutdown is bounded by `SHUTDOWN_TIMEOUT_MS = 15_000` (5 s per-supervisor ffmpeg `SIGTERM → SIGKILL` plus Hono's in-flight drain). If we hit the ceiling, hard-exit `1`. Idempotent: a second signal while already shutting down is ignored.
- **Thrown exception inside a Hono route handler** → caught by `app.onError`, returns `500 {"error":"internal_server_error"}`. Watchdog sees 2xx-or-5xx (not `000`), does **not** restart. Server stays alive so the next request can succeed and logs retain context. ✔ Matches Req J.
- **`uncaughtException` / `unhandledRejection`** (bugs outside a route — e.g. in the stage supervisor once it lands) → log and `process.exit(1)`. These signal genuinely unknown state; continuing would be unsafe.

This matches the Whatbox deploy pattern in WEEK0_LOG.md Step 2 — `@reboot` cron starts the engine via `nohup`, `* * * * *` cron pings `/api/health`, any 3-tick connection failure triggers `kill $(cat engine.pid)` + respawn.

## Source layout

```text
src/
├── app.ts                         # createApp({ registry? }), resolvePort() — pure, no side effects on import
├── app.test.ts                    # unit tests for HTTP contract + /api/stages + /api/stages/:id/now
├── config.ts                      # loadConfig(env) → EngineConfig | { errors[] } — boot validation
├── config.test.ts
├── bootstrap.ts                   # bootstrap(input) → { app, registry, poller, shutdown }
├── bootstrap.test.ts              # mock-driven coverage of the full wiring flow
├── hls.ts                         # /hls/<stage>/<file> handler (path-traversal guard, HLS headers, CORS)
├── hls.test.ts                    # 12 tests: m3u8 + segment serving, every rejection path, symlink limitation
├── shutdown.test.ts               # integration: spawn index.ts, send signals, assert exit codes
├── index.ts                       # entry point: loadConfig → bootstrap → serve → signals
├── plex/
│   ├── client.ts                  # createPlexClient() → fetchPlaylist(ratingKey): FetchPlaylistResult
│   ├── client.test.ts             # covers the full error taxonomy + pagination
│   ├── schema.ts                  # zod schemas for the Plex playlist payload
│   ├── fallback-hash.ts           # stable ID when ratingKey rotates
│   ├── fallback-hash.test.ts
│   └── index.ts                   # package-local barrel
└── stages/
    ├── ffmpeg-args.ts             # pure argv builder for `ffmpeg -> HLS` (Reqs K/L/M/O/P)
    ├── ffmpeg-args.test.ts
    ├── runner.ts                  # spawns one ffmpeg, resolves to { ok | aborted | crashed }
    ├── runner.test.ts             # uses `node -e` as a fake ffmpeg for portability
    ├── hls-dir.ts                 # prepare + clean the per-stage HLS output directory
    ├── hls-dir.test.ts
    ├── preflight.ts               # fs.stat-based track validation (missing / empty / non-file)
    ├── preflight.test.ts
    ├── watchers.ts                # first-segment watchdog (no-progress detection)
    ├── watchers.test.ts
    ├── supervisor.ts              # startStage() — sequential track loop, crash restart, stop()
    ├── supervisor.test.ts         # controlled-runner mock drives the full state machine
    ├── registry.ts                # createStageRegistry() — Map<stageId, StageController>
    ├── registry.test.ts
    ├── poller.ts                  # startPlexPoller() — 60 s loop, set-diff, restart-on-change
    ├── poller.test.ts
    ├── integration.test.ts        # end-to-end against real ffmpeg (auto-skips if absent)
    ├── audio-integrity.test.ts    # decode HLS back to PCM, assert click-free + silence floor
    └── index.ts                   # public surface for the engine entry point
```

`app.ts` and every `stages/*.ts` module have **no top-level side effects**, so unit tests import them freely without a port bind or fs scribbles. `index.ts` does the binding and signal wiring; it is exercised by `shutdown.test.ts` which spawns it as a child process and sends real signals.

## Stage supervisor (Task 3)

One `StageController` per stage. Contract:

```ts
import { startStage } from "./stages/index.ts";

const ctl = startStage({
  stageId: "opening",
  tracks: plexResult.tracks,              // from fetchPlaylist()
  hlsDir: "/dev/shm/1008/radio-hls/opening",
  fallbackFile: "/path/to/curating.aac",  // loops via -stream_loop -1 when tracks is empty
  onEvent: (e) => { /* track_started, track_ended, crash, status, ... */ },
  onStderrLine: (line) => console.warn(`[ffmpeg:opening] ${line}`),
});
// ...
await ctl.stop();  // SIGTERM current ffmpeg, SIGKILL after 5s if stubborn
```

**What it owns:**

- **Directory lifecycle.** `mkdir -p` on start; wipes `index.m3u8` + `seg-*.ts` from any previous run so the first spawn is a clean slate. Between tracks the dir is NOT touched — cross-track segment numbering relies on ffmpeg's `+append_list` reading the existing m3u8 (verified in WEEK0_LOG Step 3b).
- **One ffmpeg per track (Req K).** Built from `buildFfmpegArgs()` — see that module for the full flag list and the *why* behind each one. Track boundary = ffmpeg `exit` event in Node; no stderr parsing (Req N). Critical flag: `-re` paces input at real time, so a 5-minute track takes ~5 real minutes and the rolling 6-segment, 3-second-each HLS window stays populated.
- **Fallback for empty playlists (Req O).** When `tracks.length === 0`, wraps the input with `-stream_loop -1` so ffmpeg never exits on its own. Status stays `curating`. The fallback file is validated via `preflightTrack` before we spawn — a missing/empty fallback exits cleanly rather than hot-looping `-stream_loop -1` failures.
- **Pre-flight (hardening).** Every track runs through `fs.stat` before ffmpeg is spawned — missing file / dangling symlink / directory / zero-byte / sub-1 KiB files all get rejected fast as `preflight_failed`, no ffmpeg startup burned. This is the killer case for stale Plex paths (rename / rescan lag) — 3 × ENOENT-retries was self-inflicted silence.
- **Crash restart + dead-track TTL.** Non-zero exit → sleeps `restartBackoffMs` (default 500 ms) → retries the SAME track. After `maxConsecutiveCrashes` in a row (default 3) on a single track, OR after a preflight failure, the track is marked dead for `deadTtlMs` (default 10 minutes). Transient Whatbox I/O hiccups recover on their own; genuinely corrupt files stay skipped but come back into rotation when Plex rescans. If all tracks are dead right now, the stage falls through to the curating loop.
- **First-segment watchdog (hardening).** After spawning ffmpeg, the supervisor watches `hlsDir` for the first `seg-*.ts` to appear within `firstSegmentTimeoutMs` (default 5 s). If the deadline passes with no segment — meaning libav is hanging on an unreadable file or the kernel is stalled on tmpfs — the supervisor aborts the child and classifies the outcome as a synthetic crash. Emits `watchdog_timeout`. Set to 0 to disable (and fall back to the legacy "emit track_started at spawn" behavior).
- **Honest now-playing.** The `track_started` event fires only after the first segment lands on disk. Before that moment the supervisor doesn't claim the track is "now playing" — `currentTrack()` and any downstream WebSocket feed show the previous track's state until there's actual audio being produced.
- **Graceful stop.** `stop()` aborts the internal `AbortController`. The runner translates that into `SIGTERM`, escalates to `SIGKILL` after 5 s, and resolves `aborted`. `stop()` resolves after the run loop has exited and the status has transitioned to `stopped`. Idempotent: multiple concurrent `stop()` calls share the same promise.
- **Observer safety.** A throwing `onEvent` or `onStderrLine` is swallowed — a subscriber bug can never take a stage down.

**What it does NOT do** (those are later tasks):

- No Plex polling loop — `tracks` is captured at start. Dynamic playlist changes land when Task 5 wires the supervisor into `index.ts` with a periodic `fetchPlaylist` refresh.
- No HTTP endpoints, no WebSocket emission. Those consume the `StageEvent` stream from outside (Task 5).
- No listener counting.

**Testing layers:**

- `ffmpeg-args.test.ts` — argv shape, flag ordering, input- vs output-option position.
- `runner.test.ts` — spawn lifecycle via `node -e "<script>"` as a portable fake ffmpeg: exit codes, abort cooperation, SIGKILL escalation, stderr line buffering, idempotent abort, no listener leak.
- `hls-dir.test.ts` — recursive mkdir, selective cleanup, near-miss filename safety.
- `supervisor.test.ts` — a controlled runner mock drives the full state machine: sequential advance, wraparound, crash retry + backoff, advance after `maxConsecutiveCrashes`, empty-playlist fallback, idempotent stop, abort during backoff.
- `integration.test.ts` — end-to-end against real ffmpeg on a lavfi-generated silence fixture. Auto-skips when ffmpeg isn't on PATH. CI installs ffmpeg explicitly for this reason (see `.github/workflows/ci.yml`).

## Deferred

Coming in later Week 1 tasks:

- **Task 5 epilogue** — WebSocket hub for `track_changed` events (UI optimization; the existing REST `/now` endpoint covers polling).
- **Task 6** — `deploy/bin/start-engine.sh`, cron entries, watchdog port from v2.
- **Task 7** — ship to `v3.nicemouth.box.ca`.
