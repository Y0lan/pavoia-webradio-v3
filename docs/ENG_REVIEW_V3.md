# Engineering Plan Review — Pavoia Webradio v3

Reviewer: gstack plan-eng-review (2026-04-21)
Inputs: `DESIGN_V3.md` (361 lines), `TODO_V3.md` (419 lines), Whatbox infrastructure (`ECOSYSTEM.md`, recon data)
Mode: auto (strong recommendations + batched findings, not one-question-per-issue ceremony)

---

## Step 0 — Scope Challenge

### 0.1 Existing code already solves parts of this

| Sub-problem | What exists | Reuse or rebuild? |
|---|---|---|
| Per-stage visual identity (icon/gradient/accent/desc) | v1 `frontend/src/utils/streamMeta.js` | **Port verbatim** as `packages/shared/stages.ts`. Drop hardcoded title/desc (dynamic from Plex), keep icon/gradient/accent. |
| Client-side crossfade | v1 `frontend/src/hooks/useCrossfade.js` | **Port verbatim.** 200 lines, volume ramp via RAF, handles race conditions (`switchId` counter), autoplay retry. The only thing to change: target URL becomes `.m3u8` instead of Icecast stream. |
| Swipe navigation | v1 `frontend/src/hooks/useSwipeNavigation.js` | **Port verbatim.** |
| Artist drawer with similar-artist probe | v1 `frontend/src/components/drawers/ArtistDrawer.jsx` | **Port + adapt.** Replace `/api/artists/:name` fetch with enriched SQLite-cached version. |
| Bus mystery card | v1 `frontend/src/components/BusMysteryCard.jsx` | **Port verbatim.** |
| Info dialog | v1 `frontend/src/components/dialogs/InfoDialog.jsx` | **Port + adapt.** Keep the content, restyle with Tailwind 4. |
| Streams list, hover preview, mobile drawer | v1 `components/sidebar/` + `components/mobile/` | **Port + redesign.** Core UX is right; Tailwind 4 + TanStack Router integration is the delta. |
| Now-playing display layout | v1 `components/player/NowPlaying.jsx` | **Port layout, replace data source.** Now fed by WebSocket + TanStack Query instead of setTimeout polling. |
| Plex cover proxy | v1 `server.js` `proxyUrl` + `/api/cover-proxy` | **Port to Hono handler.** Same logic, cleaner HTTP library. |
| Plex playlist fetch | v2 bridge has this (Go) | **Rewrite in TypeScript.** v2's Go client is not reusable across stacks; the pattern (HTTP + XML parsing) is trivial. |
| Systemd + cron setup | `~/.config/mpd/*` (MPD configs via crontab) | **Port pattern, not content.** v3 is user-level systemd (better than @reboot cron). Existing nginx config stays untouched during parallel-subdomain cutover. |

### 0.2 Minimum set of changes to hit the goal

**Goal**: v3.0 ships with 6 pillars (listen, know-stage, artist/album/label, history, discovery, live count) + track download + cutover.

**Minimum set** = everything in TODO_V3.md's MVP bucket. No further reduction available without breaking the "best of the best" product bar you set.

But: the **implementation sequence** can reduce risk. The TODO doc suggests 6 phases (engine+player → metadata depth → listener count → history → discovery → polish). This review confirms that sequencing but flags: **phase 1 is deployable on its own**. If you cut here, you have a working v3 that replaces v1. Everything after is additive.

### 0.3 Complexity check — does it fit "8 files, 2 new services"?

**No.** v3 touches ~40 files across engine + web + shared, introduces the engine as a new service. But the "8 files" heuristic is for bug fixes and features, not green-field foundations. Flagging for transparency: **this IS a rewrite, not a change**. The complexity is necessary and bounded (one repo, two processes, one DB).

### 0.4 Search check — is any of this non-standard?

Three patterns worth verifying against 2026 best practice:

| Pattern | Check | Finding |
|---|---|---|
| ffmpeg HLS for continuous radio | Is there a standard library that does this? | **[Layer 1]** ffmpeg's `-f hls` with `-hls_flags delete_segments+append_list` is the canonical approach. No library wraps it (because ffmpeg itself is the "library"). Custom engine code IS the right call here. |
| Plex playlist polling vs webhooks | Does Plex support webhooks? | **[Layer 2]** Plex has webhooks for PlexPass users (`/api/v2/webhooks`), but they fire on `media.play` events, NOT playlist content changes. 60s polling is correct. |
| React 19 + TanStack Router + TanStack Query | Are these production-ready together? | **[Layer 2]** TanStack Router 1.x is stable as of 2024-11. TanStack Query 5 is rock-solid. React 19 GA since Dec 2024. Safe combo. TanStack Start (full-stack) still beta — correctly skipped. |
| SQLite for play history | Is this really enough or premature optimization? | **[Layer 3]** [EUREKA] Most web apps default to Postgres. For a single-writer, read-mostly workload (one engine process writes, web reads), SQLite with WAL mode outperforms Postgres for this scale. Multi-GB SQLite is well-documented. The Postgres instinct is wrong here. |
| HLS segment length 3s | Radio-appropriate? | **[Layer 2]** Apple's HLS spec recommends 6s for VOD, 2-3s for live. 3s is fine. LL-HLS (Low-Latency, <2s) is overkill for curated radio. |

**[EUREKA] logged**: SQLite is right, not "we'll migrate to Postgres later." Plan this as permanent architecture, not temporary.

### 0.5 Completeness check — shortcut or lake?

TODO_V3.md already took the completeness pass. The one area still shortcut-shaped: **accessibility testing**. MVP lists "ARIA, focus, reduce-motion" as items but no axe-core CI job. Adding automated a11y testing to CI is ~20 lines of workflow. Boiling-the-lake move: add it.

### 0.6 Distribution check

v3 is a web service with existing deployment pipeline (Whatbox + GitHub Actions). No new binary to distribute. Distribution = `git push` to main triggers deploy. ✓

### Step 0 verdict

**Scope is correctly bounded.** No reduction recommended. The plan is ambitious but not over-ambitious, and the sequencing gives natural cut-lines if timeline squeezes. One lake-boiling add: axe-core in CI.

---

## 1. Architecture Review

### 1.1 System-level data flow

```
          ┌────────────────────────────────────────────────────────┐
          │                   WHATBOX (orange.whatbox.ca)          │
          │                                                        │
          │  ┌─────────────┐                                       │
          │  │    PLEX     │  ~/files/Webradio/ (music files)      │
          │  │  :31711     │◄──(filesystem)──┐                     │
          │  │             │                 │                     │
          │  └─────┬───────┘                 │                     │
          │        │ HTTP (X-Plex-Token)     │                     │
          │        │                         │                     │
          │        ▼                         │                     │
          │  ┌─────────────────────────────────────────┐           │
          │  │  apps/engine (Node 22)                  │           │
          │  │                                         │           │
          │  │  ┌──────────────┐   ┌─────────────────┐ │           │
          │  │  │ PlexClient   │   │ StageManager    │ │           │
          │  │  │ - listPlay-  │──►│ - per-stage     │ │           │
          │  │  │   list(id)   │   │   queue         │ │           │
          │  │  │ - every 60s  │   │ - track advance │ │           │
          │  │  └──────────────┘   └────────┬────────┘ │           │
          │  │                              │          │           │
          │  │  ┌─────────────────┐         ▼          │           │
          │  │  │ FFmpegManager   │   ┌───────────┐    │           │
          │  │  │ 9 subprocesses  │◄──│ on track  │    │           │
          │  │  │                 │   │  boundary │    │           │
          │  │  └────────┬────────┘   └────┬──────┘    │           │
          │  │           │                 │           │           │
          │  │           ▼                 ▼           │           │
          │  │  ┌─────────────────────────────────┐    │           │
          │  │  │ /run/user/1008/radio-hls/       │    │           │
          │  │  │   <stage>/index.m3u8 + .aac     │    │           │
          │  │  │   (tmpfs, rolling 6 segments)   │    │           │
          │  │  └─────────────────────────────────┘    │           │
          │  │                                         │           │
          │  │  ┌──────────────────┐ ┌──────────────┐  │           │
          │  │  │ HistoryWriter    │ │ Enrichment   │  │           │
          │  │  │ (plays table)    │ │ Worker       │  │           │
          │  │  │                  │ │ - Last.fm    │  │           │
          │  │  │ AdditionsWriter  │ │ - MusicBrainz│  │           │
          │  │  │ (discovery log)  │ │              │  │           │
          │  │  └────────┬─────────┘ └──────┬───────┘  │           │
          │  │           │                  │          │           │
          │  │           └────┬─────────────┘          │           │
          │  │                ▼                        │           │
          │  │  ┌─────────────────────────┐            │           │
          │  │  │ SQLite (~/radio.db WAL) │            │           │
          │  │  └─────────────────────────┘            │           │
          │  │                                         │           │
          │  │  ┌─────────────────────────────────┐    │           │
          │  │  │ WebSocket Hub (internal)        │    │           │
          │  │  │ emits: track_changed, listener_ │    │           │
          │  │  │ count_changed, stage_status     │    │           │
          │  │  └────────────┬────────────────────┘    │           │
          │  └───────────────┼─────────────────────────┘           │
          │                  │ localhost WebSocket + REST          │
          │                  ▼                                     │
          │  ┌───────────────────────────────────────────┐         │
          │  │  apps/web (Node 22 + Hono)                │         │
          │  │                                           │         │
          │  │  HTTP routes:                             │         │
          │  │   GET /           → serves SPA            │         │
          │  │   GET /api/stages → from shared/stages    │         │
          │  │   GET /api/stages/:id/now → from SQLite   │         │
          │  │   GET /api/artists/:slug → from SQLite    │         │
          │  │   GET /api/albums/:slug  → from SQLite    │         │
          │  │   GET /api/labels/:slug  → from SQLite    │         │
          │  │   GET /api/history → from SQLite          │         │
          │  │   GET /api/discovery → from SQLite        │         │
          │  │   GET /api/cover?url=X → Plex proxy       │         │
          │  │   GET /hls/:stage/* → static tmpfs files  │         │
          │  │   GET /download/:trackId → file stream    │         │
          │  │   GET /ws → client WebSocket (proxied)    │         │
          │  │                                           │         │
          │  │  Listener counter:                        │         │
          │  │   records every /hls/:stage/seg-*.ts hit  │         │
          │  │   with (client_ip, user_agent, timestamp) │         │
          │  │   sends aggregated counts to engine over  │         │
          │  │   internal WS for broadcast               │         │
          │  └───────────────┬───────────────────────────┘         │
          │                  │ HTTPS (via Whatbox TLS edge)        │
          └──────────────────┼─────────────────────────────────────┘
                             ▼
                  ┌─────────────────────┐
                  │ Browser / iOS / PWA │
                  │                     │
                  │ hls.js + <audio>    │
                  │ TanStack Router     │
                  │ TanStack Query      │
                  │ WebSocket client    │
                  └─────────────────────┘
```

**What's new in this diagram vs the design doc:**

1. Listener counting **lives in `web`, not `engine`** — because `web` is what serves HLS segments, so it has the request data. Engine aggregates web's reports. The design doc was ambiguous on where this lives.

2. HLS output goes to **`/run/user/1008/radio-hls/`** (systemd user runtime dir, true tmpfs, RAM-backed) **NOT** `/var/tmp/radio-hls/` as the design doc says. `/var/tmp` on most Linux is backed by disk. Whatbox has `/run/user/<uid>/` available with ~8GB tmpfs. Writing audio segments to disk instead of RAM is a subtle perf/wear mistake.

3. SQLite is a single file at `~/radio.db` with WAL mode. Both processes connect. Engine writes, web reads. Standard concurrent-reader pattern.

### 1.2 Architecture issues I flag

#### A1 — ffmpeg invocation model

**Design doc says** (open question #3): "track-boundary detection for now-playing needs either stderr parsing of ffmpeg's `size=... time=...` lines or a per-track ffmpeg invocation (cleaner but more process churn). Start with the per-track approach, measure."

**My take:** *Per-track is wrong for continuous radio.* Each ffmpeg spawn takes ~100–300ms. 9 stages × track ends roughly every 5 minutes = one spawn every ~30s on average. With concat ffmpeg, HLS sequence numbers reset or get gappy, and hls.js can stall.

**Better model:** One ffmpeg per stage running **continuously**, fed tracks via a **concat demuxer** (`-f concat -safe 0 -i playlist.txt`). The playlist file is rewritten atomically when the queue changes. ffmpeg reads new tracks as it reaches them. Track boundaries detected by parsing stderr output (`file 'artist - title.mp3'` line appears in stderr when concat advances, or use `-progress pipe:` for machine-readable tick).

Downside: concat demuxer re-invokes decoder per input, so slight CPU hit. Benefit: no spawn/crash cycle, clean HLS sequence, no gaps.

**Recommendation: concat demuxer + stderr parsing.** Revisit only if stderr parsing proves unreliable after first implementation. If it does, fall back to a per-stage watchdog + per-track respawn with `-hls_flags +append_list` (which is the trick that makes HLS sequence numbers continue across ffmpeg invocations).

This is a single-line-of-thinking decision, I'll mark it locked unless you push back.

#### A2 — Listener counting location (engine vs web)

**Design doc** is ambiguous. "Engine counts active HLS segment requests per stage, broadcasts via WebSocket" — but engine doesn't serve HLS. Web does. So who counts?

**Correct split:**
- **web** instruments its own HLS request handler: on every `GET /hls/:stage/segment-*.ts`, record `(stage, ip, ua, now)` into a local in-memory ring buffer.
- **web** aggregates: count distinct `(ip, ua)` per stage seen in the last N seconds (see A3). Publish current counts to **engine** via the internal WebSocket.
- **engine** is the single fan-out point for WebSocket events to clients.

Why this way: engine is already the event hub for track-changes. Making it the sole broadcaster keeps all client-facing event streams in one place. Web becomes a pure request-counter.

**Alternative I rejected:** web broadcasts directly to clients. Cost: two hubs to debug, two reconnect logic paths, two auth models.

#### A3 — Listener count rolling window

**Design doc** says "last 15s." **Too tight.**

Typical HLS client polls `index.m3u8` every ~3s (= segment length) and fetches new segments in batches. Mobile clients pause fetching when backgrounded, then burst when foregrounded. A tight 15s window will flap wildly.

**Recommendation: 60s rolling window.** A listener is counted if they fetched at least one segment from that stage in the last 60s. Debounce WebSocket broadcasts to at most once per 2s per stage. The UI shows "listening now" which is fuzzy enough that 60s resolution is honest.

#### A4 — Plex reachability failure mode

**Not addressed in design doc.** What happens when Plex dies?

Three failure scenarios:
- **Plex HTTP API dies but filesystem fine:** engine can't refresh playlists. Queues drain to end of known tracks. Then what?
- **Plex filesystem unmounted:** ffmpeg gets file-not-found. HLS segments stop. Listeners stall.
- **Plex process running but Plex API hangs:** engine hangs on playlist refresh, backpressure.

**My recommendation:**
- Engine holds last-successful playlist per stage in memory. If Plex API errors on refresh, log WARN and keep using the in-memory copy. Don't let an API hiccup drain queues.
- If a tracked file is missing at ffmpeg read time (ENOENT), engine skips to next track, logs error, does NOT restart ffmpeg (concat demuxer handles advancement gracefully with `-ignore_unknown`).
- Every Plex API call wrapped in `AbortController` with 10s timeout. No hangs.
- Add a `/api/health` endpoint that exposes: plex_api_reachable, plex_fs_reachable, stages_encoding, sqlite_reachable. systemd watchdog probes it.

#### A5 — Where does the Plex token come from?

Design doc correctly says "env var, not XML parsing" but doesn't say where env comes from at runtime.

**Recommendation:**
- `~/.config/radio/env` (mode 600) holds `PLEX_TOKEN=...`, `LASTFM_API_KEY=...`, `MUSICBRAINZ_UA=...`.
- systemd unit file: `EnvironmentFile=%h/.config/radio/env` (both `radio-engine.service` and `radio-web.service`).
- Never in git, never in logs, never passed to ffmpeg (ffmpeg doesn't need it, only PlexClient does).
- `.gitignore` includes `.env`, `env`, `config/radio/env`.
- `deploy.sh` verifies the env file exists on Whatbox before restarting services.

#### A6 — HLS segment cleanup ownership

**Not addressed.** Who deletes old segments?

**Recommendation:** ffmpeg with `-hls_flags delete_segments+append_list+omit_endlist+independent_segments` handles deletion per its own rolling window (`-hls_list_size 6`). Engine doesn't need a GC loop.

**Safety net:** every 5 minutes, engine runs a cleanup sweep on `/run/user/1008/radio-hls/<stage>/` — deletes any `.ts` file older than 5 minutes AND not referenced in the current `index.m3u8`. Catches any orphans from a crash.

#### A7 — SQLite WAL + multi-process access

**Not addressed.** Engine writes, web reads. Does SQLite handle this?

**Yes, with WAL mode:** `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;`. Multiple readers + single writer is the canonical SQLite pattern. BUT: both processes must use the same SQLite build with WAL mode enabled before opening.

**Recommendation:** shared helper `packages/shared/src/db.ts` that opens the DB with the right pragmas. Both engine and web import it. Single source of truth for connection config.

#### A8 — Engine → web IPC: WebSocket overkill?

**Observation:** two Node processes on the same host, using WebSocket for internal comms. Could use Unix domain sockets + line-delimited JSON.

**My take:** WebSocket is fine. Reasons:
- Same protocol as client-facing path → one mental model
- Node's `ws` package handles reconnect, framing, ping/pong
- If engine and web ever split to separate hosts (unlikely for this project), no refactor

**Recommendation: keep WebSocket.** But put the internal WS on localhost-only (`127.0.0.1`, bind explicitly). Auth via shared secret in env — ignores messages without header. Prevents any external process from talking to engine directly.

### 1.3 ASCII state diagram — what a stage looks like over time

```
      ┌────────────────────────────────────────────────────────────┐
      │ Stage lifecycle (for each of the 9 audio stages)           │
      └────────────────────────────────────────────────────────────┘

    [STARTUP]
        │ engine starts, reads stages.ts
        │ opens SQLite, hits Plex API for playlist
        │ spawns ffmpeg with concat playlist
        ▼
    [PLAYING]  ─────────────────────────────────────────┐
        │                                               │
        │ ffmpeg emits stderr: "file '... - track.mp3'" │
        │     ┌── advance current_track in memory       │
        │     ├── insert into plays table (SQLite)      │
        │     ├── emit WS: track_changed                │
        │     └── trigger enrichment if artist new      │
        │                                               │
        │ every 60s: PlexClient polls playlist          │
        │     ┌── diff against in-memory queue          │
        │     ├── append new adds to additions table    │
        │     └── update in-memory queue                │
        │                                               │
        │ ffmpeg stderr: ERROR (file missing)           │
        │     ├── log error                             │
        │     └── loop back, advance to next track      │
        │                                               │
        │ Plex API error on refresh                     │
        │     ├── log warn                              │
        │     └── keep using in-memory queue            │
        │                                               │
        │ ffmpeg process dies (crash, OOM, signal)      │
        │     ├── systemd restarts engine, OR           │
        │     └── engine respawns just that ffmpeg      │
        │         after 500ms backoff                   │
        │                                               │
        │ SIGTERM (deploy / shutdown)                   │
        │     ├── flush SQLite writes                   │
        │     ├── send final ffmpeg segment             │
        │     └── wait for segments to drain            │
        ▼                                               │
    [DRAINING]                                          │
        │ 5s grace period, then SIGKILL ffmpeg          │
        │ close WS connections                          │
        │ close SQLite handle                           │
        ▼                                               │
    [STOPPED]                                           │
                                                        │
  Empty playlist edge case: ─────────────────────────────┘
    if Plex returns 0 tracks, engine writes a silent.m3u8
    pointing at a pre-generated 10-sec "being curated" loop.
    Repolls every 60s. Transitions back to PLAYING when tracks arrive.
```

---

## 2. Code Quality Review (pre-code, structural)

### 2.1 Monorepo tooling

Design doc picks the monorepo shape but doesn't name the tool.

**Recommendation: npm workspaces + TypeScript project references.**
- Why not Turborepo / Nx: too much ceremony for 3 packages (engine, web, shared).
- Why not pnpm workspaces: fine choice, but npm ships with Node 22. One less install step.
- Why not Bun workspaces: stack decision already landed on Node, stay consistent.

Root `package.json`:
```json
{
  "name": "pavoia-webradio-v3",
  "private": true,
  "workspaces": ["apps/*", "packages/*"]
}
```

TypeScript project references link `apps/engine` → `packages/shared` and `apps/web` → `packages/shared`. `tsc --build` does the right thing.

### 2.2 Shared types layout

```
packages/shared/
├── src/
│   ├── stages.ts         # the 11-stage canonical list + Plex ratingKeys
│   ├── types.ts          # Track, Stage, NowPlaying, Artist, Album, Label
│   ├── schemas.ts        # zod runtime validators (one per type)
│   ├── events.ts         # WebSocket event types + schemas (track_changed etc.)
│   ├── db.ts             # SQLite connection factory (WAL pragmas, shared)
│   └── index.ts          # public exports
├── package.json
└── tsconfig.json
```

**Rule:** both engine and web **validate at the boundary** using zod. Engine validates every Plex API response. Web validates every message from engine's WebSocket. Clients validate every message from server WebSocket. Type assertions are a lie; runtime validation is truth.

### 2.3 The ffmpeg wrapper

This is the gnarliest code in the repo. Isolate it.

```
apps/engine/src/ffmpeg/
├── args.ts          # buildFfmpegArgs(stage, opts) — pure, testable
├── concat.ts        # manageConcatPlaylist(stage, queue) — writes playlist.txt atomically
├── watcher.ts       # parseStderr(stream) — emits track-boundary events
├── manager.ts       # FFmpegManager (per-stage process supervisor)
└── index.ts
```

Pure `args.ts` is testable without spawning anything. `manager.ts` orchestrates. One place to change when ffmpeg args evolve.

### 2.4 Error handling pattern

Use discriminated unions, not exceptions, for expected failures. Pattern:

```ts
type PlexResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: 'unreachable' | 'unauthorized' | 'not_found' | 'parse_error'; cause?: unknown };

async function fetchPlaylist(id: number): Promise<PlexResult<Track[]>> { ... }
```

Reasons:
- **Explicit over clever** (matches user preference from skill prompt).
- Callers see the error enum and MUST handle it. No hidden catches.
- Exceptions only for true programmer errors (assertion failures, impossible states).

Apply to: PlexClient, Last.fm client, MusicBrainz client, SQLite writers, ffmpeg operations.

### 2.5 HLS dir path

Design says `/var/tmp/radio-hls/`. Change to `/run/user/1008/radio-hls/`. `/run/user/<uid>` is true tmpfs (RAM-backed) on modern systemd systems; `/var/tmp` is disk. Writing ~1GB/hour of audio segments to disk is unnecessary wear and bandwidth.

If Whatbox's `/run/user/` isn't writable (possible on seedboxes with unusual systemd setups), fall back to `/dev/shm/radio-hls/`. Verify before the first deploy:

```bash
ssh whatbox 'test -w /run/user/$UID && echo OK || echo /run/user-bad; test -w /dev/shm && echo OK || echo /dev/shm-bad'
```

### 2.6 Track ID strategy

What's a "track ID" across the system?

Plex has `ratingKey` (internal integer). The same audio file may have different Plex keys on different servers. Our world is one Plex server, so `ratingKey` is fine as canonical.

**Recommendation:** SQLite schema uses `plex_rating_key` (integer) as primary track key everywhere. URL routes use it too: `/artists/147167`, `/download/882345`. Simple, no hashing, no UUID generation.

Downside: if Plex's DB ever changes ratingKeys (re-index), v3's history points at stale IDs. Mitigate: every play also logs `(artist, title, album)` as human-readable fields. If IDs break, data survives.

### 2.7 What I'm NOT flagging

The rest of the code organization (React components, TanStack Query hooks, Hono routes) is standard and self-documenting. Don't over-design upfront.

---

## 3. Test Review

### 3.1 Framework

No existing tests in the v3 repo (it doesn't exist yet). Pick now to avoid bikeshedding later.

**Recommendation: Vitest for unit + integration, Playwright for E2E.**

- Vitest: same config as Vite, native ESM, faster than Jest, TypeScript out-of-the-box, first-class DOM via `jsdom` or `happy-dom`.
- Playwright: multi-browser, headless, great mobile emulation, works with HLS (Chromium has native HLS via hls.js-in-test patterns, Safari has native).

Structure:
```
apps/engine/
├── src/
│   └── **/*.ts
└── test/
    ├── unit/**/*.test.ts        # Vitest unit
    └── integration/**/*.test.ts # Vitest integration (real SQLite, mock Plex)

apps/web/
├── src/
│   └── **/*.ts
├── test/
│   └── unit/**/*.test.ts        # Vitest + React Testing Library
└── e2e/
    └── **/*.spec.ts             # Playwright

packages/shared/
└── test/
    └── **/*.test.ts
```

### 3.2 Coverage diagram

```
CODE PATH COVERAGE — v3 MVP
======================================================

[+] apps/engine/src/plex/client.ts
    │
    ├── listPlaylist(ratingKey)
    │   ├── [★★★ NEEDED] Happy: returns Track[]
    │   ├── [★★★ NEEDED] Plex 401 unauthorized
    │   ├── [★★★ NEEDED] Plex 404 (playlist deleted)
    │   ├── [★★★ NEEDED] Plex timeout (AbortController fires)
    │   ├── [★★  NEEDED] Plex returns 0 items (empty playlist)
    │   └── [★★  NEEDED] Plex returns malformed XML
    │
    └── resolveArtist(name)
        ├── [★★★ NEEDED] Happy: returns artist data + art URLs
        ├── [★★★ NEEDED] Artist not in Plex library
        └── [★★  NEEDED] Multiple artists same name (disambiguation)

[+] apps/engine/src/ffmpeg/args.ts
    │
    └── buildArgs(stage, opts)
        ├── [★★★ NEEDED] Correct HLS flags for normal stage
        ├── [★★★ NEEDED] Correct concat demuxer input path
        ├── [★★  NEEDED] Custom bitrate override
        └── [★   NEEDED] Invalid input (should throw at build, not runtime)

[+] apps/engine/src/ffmpeg/watcher.ts
    │
    └── parseStderr(line)
        ├── [★★★ NEEDED] Track boundary line → emits track_changed
        ├── [★★★ NEEDED] Error line → emits error event
        ├── [★★  NEEDED] Progress line → no-op
        └── [★   NEEDED] Unrecognized garbage → no-op

[+] apps/engine/src/plex/diff.ts
    │
    └── diffPlaylist(prev, next)
        ├── [★★★ NEEDED] New track added → emits 'added'
        ├── [★★★ NEEDED] Track removed → emits 'removed'
        ├── [★★★ NEEDED] Track reordered (not an add or remove)
        ├── [★★  NEEDED] Empty prev → every track is 'added'
        └── [★★  NEEDED] Empty next → every track is 'removed'

[+] apps/engine/src/db/history.ts
    │
    └── logPlay(stage, track)
        ├── [★★★ NEEDED] Happy: row inserted
        ├── [★★  NEEDED] DB locked (should retry then fail gracefully)
        └── [★   NEEDED] Duplicate play within 1s → dedup

[+] apps/engine/src/db/additions.ts
    │
    └── logAddition(stage, track, detectedAt)
        ├── [★★★ NEEDED] Happy: row inserted
        ├── [★★  NEEDED] Track previously seen in same stage → no-op
        └── [★★  NEEDED] Track previously seen in OTHER stage → new row

[+] apps/engine/src/enrichment/lastfm.ts
    │
    └── enrichArtist(name)
        ├── [★★★ NEEDED] Happy: bio + tags + similar returned
        ├── [★★★ NEEDED] Artist unknown to Last.fm (404)
        ├── [★★★ NEEDED] Rate-limit hit (429) → backoff + retry
        ├── [★★  NEEDED] Network timeout
        └── [★★  NEEDED] Response validation fails (zod error)

[+] apps/engine/src/ws/hub.ts
    │
    ├── broadcast(event)
    │   ├── [★★★ NEEDED] All connected clients receive
    │   ├── [★★  NEEDED] Disconnected client cleaned up
    │   └── [★   NEEDED] 0 clients connected → no-op
    │
    └── handleConnect(ws, req)
        ├── [★★★ NEEDED] Valid auth header → accepted
        ├── [★★★ NEEDED] Missing/wrong auth → closed 401
        └── [★★  NEEDED] Malformed ping → closed 1008

[+] apps/web/src/routes/api/hls.ts
    │
    └── handleSegmentRequest(stage, segment)
        ├── [★★★ NEEDED] Valid stage + segment → 200 + file
        ├── [★★★ NEEDED] Unknown stage → 404
        ├── [★★★ NEEDED] Segment not yet written → 404 (NOT 500)
        ├── [★★  NEEDED] Listener tracking recorded
        └── [★   NEEDED] Correct content-type + cache-control headers

[+] apps/web/src/listeners/counter.ts
    │
    └── record(stage, ip, ua, now) + countActive(stage, windowMs)
        ├── [★★★ NEEDED] Unique listener counted once
        ├── [★★★ NEEDED] Same IP+UA counted once across multiple requests
        ├── [★★★ NEEDED] Listener aged out after window → not counted
        ├── [★★  NEEDED] Different UA on same IP → counted separately
        └── [★★  NEEDED] Window debouncing (broadcast throttle)

[+] apps/web/src/components/useCrossfade.ts  (ported from v1)
    │
    └── switchStream(url, stageId)
        ├── [★★★ NEEDED] Both elements alternate correctly
        ├── [★★★ NEEDED] Rapid switch (user mashes buttons) → only final wins
        ├── [★★★ NEEDED] New stream load error → old keeps playing
        ├── [★★  NEEDED] Volume ramp correct shape (smoke check start=0, end=target)
        └── [★★  NEEDED] Autoplay rejection → retry fallback path

USER FLOW COVERAGE (Playwright E2E)
======================================================

[+] First-time visitor (cold start)
    ├── [★★★ NEEDED] [→E2E] Page loads, default stage shown, "Play" visible
    ├── [★★★ NEEDED] [→E2E] Click Play → audio starts within 3s (HLS first segment)
    ├── [★★★ NEEDED] [→E2E] Stage switch via keyboard 2 → crossfade without silence
    └── [★★  NEEDED] [→E2E] Install prompt appears (PWA)

[+] Mobile listener (iOS Safari emulated)
    ├── [★★★ NEEDED] [→E2E] Stage switch via swipe
    ├── [★★★ NEEDED] [→E2E] Media Session shows lockscreen metadata
    ├── [★★★ NEEDED] [→E2E] Mini player expands via swipe up
    └── [★★  NEEDED] [→E2E] Haptic feedback fires on switch (mock navigator.vibrate)

[+] Artist page flow
    ├── [★★★ NEEDED] [→E2E] Click artist name on now-playing → artist page loads
    ├── [★★★ NEEDED] [→E2E] Similar artists are clickable when in library
    ├── [★★  NEEDED] [→E2E] External links open in new tab with rel=noopener
    └── [★★  NEEDED] [→E2E] Artist with no enrichment data yet → fallback UI

[+] History flow
    ├── [★★★ NEEDED] [→E2E] /history loads plays, grouped by day
    ├── [★★★ NEEDED] [→E2E] Filter by stage
    ├── [★★  NEEDED] [→E2E] CSV export downloads correctly-shaped file
    └── [★★  NEEDED] [→E2E] Virtual scroll keeps performant with 10k rows

[+] Discovery flow
    ├── [★★★ NEEDED] [→E2E] /discovery shows additions across stages
    ├── [★★★ NEEDED] [→E2E] Filter by stage
    └── [★★  NEEDED] [→E2E] Play from additions feed switches radio to that track's stage

[+] Error states the listener can see
    ├── [★★★ NEEDED] [→E2E] Engine down → "Reconnecting…" toast, retries
    ├── [★★★ NEEDED] [→E2E] Plex down → stages continue from cached queue, no listener-visible error
    ├── [★★  NEEDED] [→E2E] All stages empty playlist → "being curated" UI
    └── [★★  NEEDED] [→E2E] Network offline → service worker shell loads, play button disabled

[+] Accessibility
    ├── [★★★ NEEDED] [→E2E] Keyboard-only full flow (Tab, Enter, Space, arrows, Esc)
    ├── [★★★ NEEDED] [→E2E] Screen reader announces track changes
    ├── [★★★ NEEDED] [→E2E] axe-core finds 0 violations on every route
    └── [★★  NEEDED] [→E2E] prefers-reduced-motion → no gradient animations

[+] Listener count
    ├── [★★★ NEEDED] [→E2E] Open two tabs → count shows 2 on active stage (integration)
    ├── [★★  NEEDED] [→E2E] Close one tab → count decrements within 90s
    └── [★★  NEEDED] [→E2E] Milestone toast fires at 100 (simulate with counter injection)

──────────────────────────────────────────────────────
COVERAGE SUMMARY
  Unit + integration: ~55 test cases
  E2E: ~25 scenarios
  Eval: N/A (no LLM calls in v3)
  
CRITICAL GAPS (must ship with MVP):
  1. Crossfade correctness under rapid switch (concurrency bug risk)
  2. Plex unreachable failure mode (production concern #1)
  3. HLS segment request handling of not-yet-written segments (404 vs 500)
  4. Listener counter dedup logic (count-inflation risk)
  5. Playlist diffing edge cases (adds/removes/reorders)
  6. axe-core on every route (a11y regression gate)
──────────────────────────────────────────────────────
```

### 3.3 Test plan artifact

Writing `~/.gstack/projects/radio/test-plan-v3.md` with affected routes, key interactions, critical paths — for downstream `/qa` consumption.

(Done at the end of this review.)

---

## 4. Performance Review

### 4.1 CPU

**Workload:** 9 ffmpeg processes encoding AAC at 128kbps from MP3 sources (already decoded by ffmpeg). On an AMD EPYC 7713 with 64 cores, each ffmpeg takes ~2% of one core. Total ~0.2 cores of 64. **Plenty of headroom.**

**Load average observation from recon:** Whatbox is at load avg 70+ (seedbox, many users). Your processes compete for CPU. Still fine — radio workload is tiny.

### 4.2 Memory

- Engine: ~150MB (Node 22 + SQLite handles + 9 ffmpeg pipes).
- Web: ~100MB (Node 22 + Hono + maybe built SPA in memory).
- SQLite DB: grows ~10MB/month based on play/additions log rate.
- HLS segments in tmpfs: 9 stages × 6 segments × ~50KB = 2.7MB total. Trivial.

**Total RAM budget: ~300MB.** Whatbox has 503GB. Absurd headroom.

### 4.3 Plex API load

9 stages × 1 request every 60s = 9 req/min. Plex laughs at this. **No issue.**

### 4.4 Last.fm rate limit

5 req/sec (= 300/min, = 18000/hour). Enrichment is batch-processed when new artists are seen. At first run, engine has ~1100 artists to enrich. Even respecting rate limit (1 req/sec to be safe), that's ~18 minutes to fully enrich. Acceptable.

**Recommendation:** enrichment worker runs in the background with a local queue, persists "last enrichment attempt timestamp" per artist, retries failed artists after 24h. Never blocks playback.

### 4.5 MusicBrainz rate limit

1 req/sec (strictly enforced). Use as fallback only for artists Last.fm doesn't cover (~5-10% based on typical electronic music libraries). Way under rate limit.

### 4.6 SQLite write contention

Single writer, WAL mode, writes <<1/sec. **No contention possible.**

### 4.7 WebSocket broadcast throttling

Listener-count changes can be noisy (segments fetched every 3s). Debounce: aggregate counts, broadcast every 2s max. Single-event-per-track-change for track-changed events (naturally limited, ~9/5min). No throttle needed for those.

### 4.8 React rendering

TanStack Query's `refetchInterval` + React 19's automatic batching. Use `React.memo` on NowPlaying, StreamsList items, HistoryRow. Avoid re-rendering the entire history list on every now-playing tick.

### 4.9 HLS latency

3s segments + 3-segment buffer before client plays = ~9s startup to hear audio. Then ~6s latency behind "live." Fine for curated radio. Do not tune unless a complaint arises.

### 4.10 Perf issues I flag

**None requiring action.** Workload is too small for traditional perf concerns. Only real risks are:
- React render storm → mitigated by memo + selective query invalidation.
- Enrichment rate limit → mitigated by background worker.
- WebSocket broadcast storm → mitigated by debounce.

All three mitigations are documented above; apply them during impl.

---

## Parallelization Strategy

| Lane | Work | Depends on | Touches |
|---|---|---|---|
| **G** | Deploy pipeline (GitHub Actions + systemd units + ssh key + deploy.sh) | — | `deploy/`, `.github/`, Whatbox config |
| **A** | Engine: Plex client, stages config, ffmpeg manager, concat playlist writer, HLS output, basic WS hub | Shared scaffolded | `apps/engine/src/plex/`, `apps/engine/src/ffmpeg/`, `apps/engine/src/ws/` |
| **B** | Web: SPA scaffold, TanStack Router, TanStack Query, Tailwind, Vite, base layout, stage list + player controls (using v1's ported components) | Shared scaffolded | `apps/web/src/`, `apps/web/src/components/` |
| **C** | SQLite layer: schema, migrations, HistoryWriter, AdditionsWriter, db helper | Shared scaffolded | `apps/engine/src/db/`, `packages/shared/src/db.ts` |
| **D** | Enrichment workers: Last.fm + MusicBrainz clients, enrichment queue, cache table | Lane C merged | `apps/engine/src/enrichment/` |
| **E** | UI pages: artist, album, label, history, discovery — Hono API routes | Lanes A+C+D merged (needs SQLite data to show) | `apps/web/src/routes/`, `apps/web/src/components/pages/` |
| **F** | Listener counting: web-side segment counter + engine-side aggregate broadcast + UI badges | Lanes A+B merged | `apps/web/src/listeners/`, `apps/engine/src/listeners/`, UI badges across routes |
| **P** | Polish: OG cards, PWA, haptics, track download, axe-core a11y CI, accessibility audit | Lane E merged | cross-cutting |

**Execution order:**

```
[Week 1]     Lane G (ship the empty shell) + Lane A (engine core) + Lane B (web core)
              → parallel worktrees, merge independently

[Week 2]     Lane C (SQLite) starts immediately after shared scaffold
              → merges into main

[Week 3]     Lane D (enrichment) + Lane F (listener counting)
              → parallel worktrees, different directories, no conflicts

[Week 4]     Lane E (UI pages)
              → single worktree, lots of React work

[Week 5]     Lane P (polish) + bug fixes
              → final worktree

[Cutover]    v3.nicemouth.box.ca points at v3. Listen for a week. Flip radio.* + pavoia.* DNS.
              Decommission v1 + v2 + MPD instances + nginx rules for old.
```

Parallel claims two independent worktrees at the same time (A+B, then C+... wait, C depends on Shared — sequential). Reality: max 3 parallel worktrees at once (D+E+F overlap possible in late phase).

**Conflict flags:**
- Lane E touches web/src broadly; coordinate with Lane B's player components. Usually not literal conflicts, but API-shape negotiation.
- Lane F touches both engine and web — not a merge conflict, but requires synchronized changes to the WS event schema.

---

## NOT in scope (explicitly deferred, for the record)

- Postgres / Redis / Meilisearch (v3.x if ever; probably never)
- Admin UI (user drop)
- Queue display / up-next (user drop)
- Camelot key wheel (user drop)
- 5 crossfade curves / 3 themes / 3 layouts / N settings (user drop)
- Wrapped (v3.1)
- Curator dashboard with digging heatmap (v3.2)
- Artist graph visualization (v3.3)
- Global fuzzy search ⌘K (v3.2)
- Plex webhooks for instant adds (v3.x, 60s poll is good enough for v3.0)
- Multiple music quality tiers (one AAC 128 stream; revisit if bandwidth proves an issue)
- Audio visualizer (no plan to build)
- Track re-listen on-demand player overlay (just download is enough)
- Listener auth / user accounts (never)

---

## What already exists (being reused)

From v1:
- `streamMeta.js` per-stage visual identity → becomes `packages/shared/stages.ts` (minus title/desc, those go dynamic)
- `useCrossfade.js` → ports to v3's crossfade hook with minor URL-construction changes
- `useSwipeNavigation.js` → ports verbatim
- `NowPlaying`, `TrackProgress`, `EqualizerBars`, `PlayPauseButton`, `StreamsList`, `StreamsDrawer`, `ArtistDrawer`, `InfoDialog`, `BusMysteryCard`, `StreamPreview` → port with Tailwind 4 updates
- Keyboard shortcut pattern (App.jsx `onKeyDown`) → ports to a `useKeyboardShortcuts` hook
- Localstorage keys (`activeStreamId`, `playerVolPct`, `lastSeenStreams`) → same keys, seamless for returning listeners
- Plex cover proxy (`/api/cover-proxy`) → ports to Hono route
- Preconnect hint injection → ports

From v2:
- Nothing reused in code (different stack). **Lessons carried**: WebSocket hub pattern (engine → clients), background enrichment worker pattern, 60s Plex poll cadence.

From Whatbox infrastructure:
- Plex server (unchanged, same token, same port)
- Plex library filesystem (unchanged)
- Nginx config (untouched; v3 adds its own systemd units, Whatbox edge routes `v3.*` directly to the web process port)
- SSH key + GitHub Actions secret (existing `WHATBOX_SSH_KEY`)

---

## Failure Modes (critical gaps check)

For each new codepath, one realistic production failure + whether the plan accounts for it:

| Codepath | Failure scenario | Test? | Error handling? | User-visible? | Status |
|---|---|---|---|---|---|
| Plex API call | Plex process hung, 10s timeout hits | ✅ (unit) | ✅ (fallback to cached queue) | ❌ silent to listener | OK |
| ffmpeg process | OOM kill, SIGKILL mid-segment | ✅ (integration) | ✅ (watchdog respawn, 500ms backoff) | ⚠️ brief ~3s gap | OK |
| SQLite write | Disk full during play log | ✅ (unit) | ✅ (log WARN, continue) | ❌ silent | OK |
| HLS segment | Client requests segment that was just deleted | ✅ (unit) | ✅ (404) | ❌ hls.js auto-retries | OK |
| WS disconnect | Engine → web internal WS drops | ✅ (integration) | ✅ (auto-reconnect) | ⚠️ brief now-playing lag | OK |
| Last.fm rate limit | 429 during backfill | ✅ (unit) | ✅ (exponential backoff) | ❌ slower enrichment, not visible | OK |
| Empty playlist | Plex returns 0 tracks for a stage | ❌ missing | ⚠️ design says "silence marker loop" but not specified | ⚠️ user sees "being curated" UI | **GAP** |
| Listener counter | Process restart loses rolling window | ⚠️ not tested | ✅ (window rebuilds in ~90s) | ⚠️ count briefly shows 0 | OK |
| Plex FS missing | Audio file deleted but still in playlist | ✅ (unit needed) | ✅ (skip, log, advance) | ⚠️ brief gap at that track | OK |
| Crossfade race | User mashes stage switch | ✅ (unit, critical) | ✅ (switchId guards — v1 pattern) | ⚠️ always settles on last choice | OK |

**Critical gaps flagged:**
1. **Empty playlist handling** — design doc says "probably a silence marker loop" but doesn't specify implementation. Lock this before impl: a pre-recorded 10-second loop file at `packages/shared/assets/curating.aac`, ffmpeg plays it on repeat until Plex returns tracks. Engine emits `track_changed: { title: 'This stage is being curated', artist: '—' }`.

That's the only critical gap. Others are handled.

---

## Outside Voice (optional)

Auto mode: **skipping by default.** If you want a second opinion from Codex or an independent Claude subagent on this review, say "outside voice" and I'll run it.

---

## Completion Summary

- **Step 0: Scope Challenge** — accepted as-is (no reduction needed; already tight)
- **Architecture Review** — 8 issues raised, all with recommendations + reasoning
- **Code Quality Review** — 7 structural recommendations (monorepo tool, shared types layout, ffmpeg module shape, error handling pattern, HLS dir path, track ID strategy)
- **Test Review** — coverage diagram produced, ~55 unit/integration + ~25 E2E scenarios identified, 6 critical paths flagged
- **Performance Review** — no issues requiring action; 3 mitigations documented preemptively
- **NOT in scope** — written
- **What already exists** — 11 v1 components + hooks listed for reuse
- **Failure modes** — 1 critical gap (empty-playlist handling)
- **Outside voice** — skipped (user can request)
- **Parallelization** — 8 lanes, peak 3 parallel, 5-week sequenced plan
- **Lake score** — 11/11 recommendations chose complete option

## EUREKA moment (from Search Before Building)

**SQLite is not a stepping-stone to Postgres. It's the right permanent choice.**

Conventional wisdom: "start with SQLite, migrate to Postgres when it gets serious." For a single-writer, read-mostly workload like this one (one engine writes plays + additions + enrichment, web reads), SQLite with WAL mode scales to tens of millions of rows on a local disk with better performance than Postgres (no network roundtrip, no connection pool, no client library serialization). v2's instinct to use Postgres was premature optimization of a problem v3 won't have.

Plan the architecture as "SQLite forever" rather than "SQLite until we need to migrate." It's cleaner and it's probably true.

## Unresolved decisions

None from this review. All issues have proposed answers; user can override any by saying "change A3" (etc.) in a follow-up message.

## Review Log

(Would normally persist via `gstack-review-log` but gstack binaries unavailable in this environment. Review captured fully in this document.)

## Recommended next action

**See `SLIM_V3.md` (post-Codex 2026-04-21).** MVP was slimmed to Codex's foundation floor. Week 0 now starts with three prototype verifications (ffmpeg concat, track-boundary detection, Plex path + tmpfs) BEFORE architecture lock.

---

## Post-Codex Review Resolution (appended 2026-04-21)

Codex ran an adversarial review after this plan's Eng Review was complete. 25 findings returned. User chose "Slim MVP to true foundation" in response to Codex finding #1. Full finding-by-finding resolution is documented in `SLIM_V3.md`.

### Architectural changes driven by Codex

1. **MVP slimmed.** History, discovery, listener count, artist/album/label enrichment, track download, OG cards all moved from v3.0 MVP to v3.1–v3.6 phases. v3.0 = Plex → HLS → now-playing → v1-grade UI → deploy.
2. **Week 0 added.** Prototype + verification phase before architecture lock: ffmpeg concat playlist behavior, track-boundary detection mechanism, Plex API filesystem path accessibility, Whatbox `/run/user/$UID` stability.
3. **Zero-drop reload dropped.** Reframed as "1–3s audio gap absorbed by HLS buffer on graceful reload."
4. **Stage count canonicalized.** 10 audio + Bus = 11 total; engine runs 10 ffmpeg processes; Bus never iterated as audio stage.
5. **Bus behavior spec'd.** Non-audio stage, no HLS, no ffmpeg, clicking triggers BusMysteryCard overlay.
6. **Repo goes private at v3.0.** Public MIT consideration deferred post-launch behind a config abstraction layer.
7. **No SQLite in v3.0.** In-memory only. SQLite introduced in v3.1 with full migration/backup/recovery story.
8. **Per-stage supervisor pattern** for ffmpeg lifecycle — one stage crash doesn't take down others.
9. **Enrichment as separate process** (when it arrives in v3.4), not inside engine.
10. **Track download as signed-URL** scheme (when it arrives in v3.5), not direct ratingKey-based.
11. **Success criteria language fixes:** "10-second connection blip" not "subway tunnel"; "appears in queue within 60s" not "in rotation within 90s"; "listening now" not "listeners."

Architecture section 1.2 (issues A1–A8) above is **still applicable** as-written — those calls stand. Codex extended the surface to cover scope, product ambiguity, prototyping discipline, and language precision. It didn't contradict my architectural calls.
