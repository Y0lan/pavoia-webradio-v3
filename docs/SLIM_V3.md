# Pavoia Webradio v3 — Slim MVP (post-Codex)

**Status:** Canonical. Supersedes the MVP bucket in `TODO_V3.md` and the "v3.0 Feature Scope" section in `DESIGN_V3.md`.

Codex found a real contradiction on 2026-04-21: the approved design said "just listener experience" but the expanded TODO pulled 70 features into MVP. Both can't be true. User chose to slim to the true foundation.

## v3.0 MVP — the foundation

Codex's cutover floor, adopted verbatim:

> **Plex playlists → continuous HLS → now playing → v1-grade UI → deploy/rollback.**

Concretely, v3.0 ships with:

### Audio engine
- 10 audio stages (`gaende-favorites`, `opening`, `ambiance-safe`, `bermuda-day`, `bermuda-night`, `fontanna-laputa`, `palac-slow-hypno`, `palac-dance`, `etage-0`, `closing`) + **Bus mystery as a non-audio stage**.
- Per-stage ffmpeg subprocess encoding to HLS (AAC 128 kbps, 3s segments, 6-segment rolling window).
- **Per-stage supervisor**: one ffmpeg crash takes down one stage, not all nine. Engine respawns with 500ms backoff.
- Plex API client: poll each playlist every 60s, detect adds/removes, update queue at next track boundary.
- In-memory now-playing state per stage. **No SQLite in v3.0.** No DB at all.
- Track-boundary detection: `ffmpeg -progress pipe:1` (structured output) OR stderr parse of concat advancement. **Prototype in Week 0 before architecture lock.**
- Empty-playlist fallback: ffmpeg plays `packages/shared/assets/curating.aac` (pre-recorded 10s loop) + now-playing emits `{ title: "This stage is being curated", artist: "—" }`.

### Player UI
- React 19 + Vite + TanStack Router + TanStack Query + Tailwind 4, TypeScript end-to-end.
- Now-playing: cover art, title, artist, album, year, duration, progress bar (port v1's components).
- Browse & Switch model (viewing ≠ playing), now-playing strip when exploring.
- Per-stage accent + gradient + icon (port `streamMeta.js` verbatim, descriptions from Plex `summary` field).
- Client-side crossfade (port `useCrossfade.js`, URL changed to `.m3u8`).
- Keyboard shortcuts (Space, ←→, ↑↓, M, 1–9, 0, Enter, Esc).
- Swipe navigation on mobile.
- Mobile mini player + full-screen expand + drawer.
- Hover preview (500ms delay, shows cover + artist + title).
- Info dialog (port v1).
- Bus mystery card (port v1, full-screen overlay, click to close).
- "Was playing" toast when returning to a stage.
- Share station (navigator.share) + deep-link to stage.
- Artist drawer — **v1-grade only** (bio + similar artists from Plex's `/library/metadata/:id`, no Last.fm/MusicBrainz enrichment yet).
- Now-playing polling via TanStack Query (5s interval, pause on tab hidden, auto-resume on visibility).

### PWA
- Manifest for install-to-home-screen.
- Service worker for app shell cache (SPA + fonts + icons). **Not** caching HLS segments.
- Media Session API (lockscreen play/pause + track metadata).
- Background audio.
- Icon maskable.

### Accessibility
- ARIA labels throughout.
- Visible focus indicators.
- Screen reader announcements on track change (aria-live).
- Semantic HTML.
- WCAG AA contrast.
- `prefers-reduced-motion` respected.
- axe-core in CI, zero Serious/Critical violations gate.

### Deploy + ops
- Monorepo (npm workspaces): `apps/engine`, `apps/web`, `packages/shared`.
- **Whatbox has no systemd.** Deploy pattern matches v1/v2 (verified 2026-04-21, see WEEK0_LOG.md Step 2).
- **Process management = cron + nohup + watchdog** (port v2's `bridge-watchdog.sh` pattern for both engine and web):
  - `@reboot sleep 10 && ~/webradio-v3/bin/start-engine.sh` starts the engine.
  - `@reboot sleep 15 && ~/webradio-v3/bin/start-web.sh` starts the web server.
  - `* * * * * ~/webradio-v3/bin/watchdog.sh` probes `/api/health` every minute. Restarts on 3 consecutive connection failures (HTTP 000). Does NOT restart on 5xx (preserves diagnostic state during degraded state).
  - Wrapper scripts source `~/.config/radio/env` before exec'ing node. No `EnvironmentFile=`.
- GitHub Actions: typecheck → test → build → rsync to Whatbox → `kill $(cat engine.pid)` → `start-engine.sh` → wait for health → repeat for web.
- **Graceful reload accepts 1–3s audio gap** (HLS client buffer absorbs it). Not "zero-drop."
- Parallel subdomain cutover (`v3.nicemouth.box.ca`).
- **HLS segments at `/dev/shm/1008/radio-hls/<stage>/`** (UID-prefixed per Whatbox multi-user tmpfs convention). Not `/run/user/$UID` (doesn't exist on seedbox). Not `/var/tmp/` (disk-backed).
- Logs to `~/webradio-v3/logs/engine.log` and `~/webradio-v3/logs/web.log`. Weekly logrotate via cron. No `journalctl`.
- Node 22.22.2 via `mise` (already installed: `/home/yolan/.local/share/mise/installs/node/22.22.2/bin/node`).

## v3.1 and beyond — the analytics tier (deferred from v3.0 MVP)

Moved out of MVP per Codex finding #1 + #24 + user decision (2026-04-21). Strict sequencing, each phase stabilizes before the next.

- **v3.1 — Play history.** SQLite + WAL, schema + migrations + nightly backup, every-track-change log, timeline view with filters, CSV export.
- **v3.2 — Discovery feed.** Plex-playlist observation (polls every 60s, diffs, logs first-seen-in-stage events), per-stage + global feeds, filters, deep-link to play.
- **v3.3 — Live listener count.** Web-side HLS-segment-request counting with 60s rolling window, WebSocket broadcast with 2s debounce, milestone toasts. Reframe copy: "listening now" not "listeners" (Codex #13 — IP+UA unreliable on venue NAT).
- **v3.4 — Artist / album / label enrichment.** Separate `apps/enrichment` worker process (not in engine — Codex #23). Last.fm primary, MusicBrainz secondary. Full artist/album/label pages. Best-effort matching with "enriching..." fallback (Codex #11 — electronic music resolution is messy).
- **v3.5 — Track download.** Signed-URL scheme: `/download/:signedToken`, tokens issued only for tracks currently in a live stage playlist, 5-minute TTL, single-use. Whitelist-based, not `ratingKey`-direct (Codex #10 — legal / path traversal).
- **v3.6 — Open Graph preview cards.** Small Hono handler that serves server-rendered HTML with meta tags when User-Agent matches scraper patterns (Codex #17 — static SPA can't do OG).
- **v3.7 — Wrapped (annual + monthly).**
- **v3.8 — Curator dashboard, advanced analytics, search.**
- **v3.9 — Artist graph.**

## Codex findings resolution table

| # | Codex finding | Status | Resolution |
|---|---|---|---|
| 1 | Scope incoherent between design doc and TODO | **APPLIED** | MVP slimmed per user choice (this doc). |
| 2 | Stage count inconsistent (9 vs 10 vs 11) | **APPLIED** | Canonical: 10 audio stages + Bus = **11 total**. Bus is a non-audio stage in UI, never counted as an ffmpeg process. Engine manages **10 ffmpeg processes**. Keyboard 1–9 map to audio stages 1–9, 0 maps to stage 10, Bus has no keyboard shortcut. |
| 3 | Bus mystery behavior unclear | **APPLIED** | Bus appears in the stage list with its icon + gradient. Clicking the Bus entry opens `BusMysteryCard` (full-screen overlay, port v1). Bus does NOT load HLS, does NOT have an ffmpeg process, does NOT have a Plex playlist. Stage counters (UI, health checks, HLS routes) never iterate Bus. |
| 4 | ffmpeg concat rewriting unproven | **APPLIED** | **Week 0 prototype:** verify ffmpeg concat demuxer with atomic playlist-file rewrites on Whatbox. Fall-back option: per-track ffmpeg invocation with `-hls_flags +append_list +omit_endlist` to keep HLS sequence numbers. Decide after prototype. |
| 5 | "Zero-drop reload" hand-waved | **APPLIED** | Reframed: "graceful reload with 1–3s audio buffer gap, absorbed by HLS client." No promise of zero interruption. |
| 6 | HLS cutover can't migrate active listeners | **ACKNOWLEDGED** | Schedule DNS flip for off-peak (early AM). Listeners pointed at `radio.*` during cutover see a brief gap; HLS will reconnect to new engine on next m3u8 poll. Acceptable. |
| 7 | hls.js crossfade fragile on mobile autoplay | **ACKNOWLEDGED** | Prototype the hls.js + two-audio-element crossfade separately from engine prototype. Port v1's user-gesture-gated play pattern. If fragile, fall back to: single audio element, swap URL, accept brief gap (no crossfade) on stage switch. Decision after prototype. |
| 8 | Track-boundary detection unsolved | **APPLIED** | **Week 0 prototype:** try `ffmpeg -progress pipe:1` FIRST (structured key=value output, pipe-safe). Fall back to stderr parse. Then, finally, ICY tags. Don't lock architecture until one of the three works on Whatbox. |
| 9 | Plex API media paths may not be direct filesystem | **APPLIED** | **Week 0 verification:** one curl against a sample track's `/library/metadata/:id`, inspect the `Media > Part > file` attribute. Confirm it's a real filesystem path the user process can read. If it's containerized, Bermuda-triangle case, OR indirect path — v3 must stream via Plex HTTP, not direct read. Decide before architecture lock. |
| 10 | Track download = legal/security footgun | **DEFERRED** | Moved to v3.5. When it ships: signed-URL scheme, whitelist of stage-playlist files only, 5-minute single-use TTL. |
| 11 | Enrichment messy for electronic music | **DEFERRED** | Moved to v3.4. Ships with "enriching..." fallback UI and explicit data-quality tier indicator. |
| 12 | SQLite migration/backup ignored | **DEFERRED** | Moved to v3.1 where SQLite first appears. v3.0 has no DB at all. When SQLite arrives: migration runner, nightly `.backup` dump to `~/files/radio-backups/`, WAL corruption recovery step documented in runbook. |
| 13 | Listener counting IP+UA unreliable | **DEFERRED + REFRAMED** | Moved to v3.3. Copy reframed: "listening now" instead of "listeners." Explicit "approximate" disclaimer in tooltip. |
| 14 | GitHub Actions → Whatbox rsync fragile (native SQLite, Node version, partial deploys) | **APPLIED** | v3.0 has no SQLite, sidesteps native-binding issue entirely. When SQLite arrives (v3.1): use Node 22's built-in `node:sqlite` (experimental but stable enough, no native build) OR prebuilt `better-sqlite3` binary matching Whatbox Node version. Deploy pipeline: fail-fast on typecheck/test, only rsync if green, health-check post-reload, auto-rollback on failed health check. |
| 15 | `/run/user/$UID` may not survive seedbox weirdness | **APPLIED** | **Week 0 verification:** ssh to Whatbox, test `/run/user/$UID` across reboot and logout cycles. If unstable, fall back to `/dev/shm/radio-hls/` or a persistent dir with explicit tmpfs mount. |
| 16 | Public repo exposes operational topology | **APPLIED** | Repo will be **private** at v3.0, public-MIT consideration deferred to post-launch when a clean config abstraction exists between code and secrets. `.gitignore` covers `.env`, `env`, `config/radio/env`. Deploy paths, playlist IDs NOT in repo — only in `~/.config/radio/env` on Whatbox. |
| 17 | OG cards need server rendering | **DEFERRED** | Moved to v3.6. Pulled from v3.0 MVP. |
| 18 | PWA / service worker stale cache risks | **APPLIED** | Careful SW versioning: every deploy bumps a version string in the SW registration, old SW versions skip-waiting-and-claim. Explicitly document in runbook. |
| 19 | Subway tunnel claim unrealistic | **APPLIED** | Rephrased in success criteria: "mobile listener during a 10-second connection blip doesn't lose their session" (HLS 6-segment buffer = ~18s of absorbable gap, 10s is safely inside that). Removed "subway tunnel." |
| 20 | "Rotation within 90s" ≠ audible within 90s | **APPLIED** | Rephrased: "new track **appears in the stage's queue** within 60 seconds of being added to the Plex playlist. Audible play time depends on current queue position." |
| 21 | Playlist diffing needs stable ID | **APPLIED** | Track identity composed as `(plex_rating_key, fallback_hash(artist, title, album))`. Both stored. If Plex ratingKey changes after a library re-index, fallback hash preserves continuity for history/discovery. |
| 22 | One engine process = SPOF for 9 stages | **APPLIED** | Per-stage supervisor pattern inside the engine. Each ffmpeg has its own `StageSupervisor` with independent lifecycle, restart-on-crash, and health-check. One stage's ffmpeg crash only restarts that stage, not the others. Shared code (Plex client, WebSocket hub) is small and thoroughly tested. |
| 23 | Enrichment in engine couples noncritical to critical | **APPLIED** | When enrichment arrives (v3.4), it's its own process: `apps/enrichment`. Reads the SQLite DB, writes artist/album/label rows. Engine never touches enrichment code. |
| 24 | No real MVP line | **APPLIED** | This doc. |
| 25 | Strategic: rewriting everything at once | **ACKNOWLEDGED** | User has made the call to rewrite. Not reopened. The slim MVP mitigates the risk by cutting the simultaneous-change surface from ~9 dimensions to ~5: streaming protocol, process model, frontend stack, deploy, v1-grade UI migration. Database / analytics / enrichment / downloads / PWA are all post-cutover. |

## Revised implementation sequence

### Week 0 — Prototype + verification (NEW, per Codex #4, #8, #9, #15)
Before writing ANY production code, verify three assumptions:
1. **ffmpeg concat demuxer with live playlist rewrites.** Prototype: one ffmpeg process reading a concat playlist that we atomically rewrite every 60s. Measure: does it pick up new entries? Any gaps at transition? Any sequence-number drift?
2. **Track-boundary detection.** Try `-progress pipe:1` first. If it reports track changes, lock that. If not, fall back to stderr parse.
3. **Plex API media paths + filesystem access + tmpfs.** Three one-liner curl/ls commands on Whatbox. Validate: Plex returns direct fs paths that our process can read, `/run/user/$UID` is writable and persists, `better-sqlite3`-free deploy works.

One afternoon. If any prototype fails, revisit the architecture BEFORE building anything.

### Week 1 — Engine MVP
- Monorepo scaffold (npm workspaces, TypeScript project refs).
- `packages/shared`: stages.ts, types, zod schemas.
- `apps/engine`: Plex client, stage supervisor, ffmpeg manager (outcome of Week 0 prototype), HLS writer, now-playing HTTP endpoints.
- Health endpoint (`/api/health` — plex_reachable, per-stage status).
- systemd unit + deploy.sh + GitHub Actions pipeline.
- Ships to `v3.nicemouth.box.ca`. Engine runs, streams play. No UI yet — verify via `curl` and VLC.

### Week 2 — Web UI
- `apps/web`: Vite + React 19 + TanStack + Tailwind.
- Stage list + player controls + now-playing + Browse & Switch.
- Port `useCrossfade`, `useSwipeNavigation`, `streamMeta.js`.
- Port v1 components: NowPlaying, TrackProgress, EqualizerBars, PlayPauseButton, StreamsList, StreamsDrawer, ArtistDrawer (v1-grade, Plex-only), InfoDialog, BusMysteryCard, StreamPreview.
- TanStack Query 5s-polling of `/api/stages/:id/now`.

### Week 3 — Polish + a11y + PWA
- Keyboard shortcuts (full set).
- PWA manifest + service worker (careful versioning).
- Media Session API.
- axe-core CI integration.
- Screen reader verification (VoiceOver + NVDA).
- Share + deep-links.
- "Was playing" toast.
- Mobile drawer, haptics on stage switch.

### Week 4 — Cutover
- Verification on `v3.nicemouth.box.ca` for at least 3 days.
- Off-peak DNS flip: `radio.nicemouth.box.ca` and `pavoia.nicemouth.box.ca` point to v3's port.
- v1 and v2 stopped.
- MPD instances stopped.
- Old nginx rules cleaned up (optional — leaving them doesn't hurt).

### Week 5+ — v3.1 (history) begins
First SQLite introduction. Separate PR. Migration runner. Nightly backup. Plays table. Timeline UI.

---

## Files to update

- ✅ `SLIM_V3.md` — this file, canonical MVP for v3.0.
- `DESIGN_V3.md` — mark "v3.0 Feature Scope" section as superseded by SLIM_V3.md, update roadmap.
- `TODO_V3.md` — mark the MVP bucket as reduced per SLIM_V3.md, update the roadmap.
- `ENG_REVIEW_V3.md` — append a "Post-Codex Resolution" section listing all 25 findings + disposition.
- (Create) `CLAUDE.md` in the new v3 repo pointing at these three docs as source of truth.
