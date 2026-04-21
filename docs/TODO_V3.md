# Pavoia Webradio v3 — Ultimate Feature Triage (revised 2026-04-21)

> ⚠️ **MVP bucket superseded by `SLIM_V3.md` (post-Codex review 2026-04-21).** The v3.0 MVP has been reduced to the "true foundation" floor: Plex playlists → continuous HLS → now-playing → v1-grade UI → deploy. Everything else (history, discovery, listener count, enrichment, artist/album/label pages, track download, OG cards) moves to v3.1+ phases.
>
> This document is preserved as the feature inventory and triage reasoning. For what-ships-in-v3.0, read SLIM_V3.md.

Consolidated from: v1 (`pavoia-webradio` live code), v2 (`GAENDE_WEBRADIO_v3.1_COMPLETE.md` spec), and the approved v3 design doc.

## Re-scope decision

User decision (2026-04-21): v3.0 is **NOT** just a v1 replacement. It's the "best of the best, minimal, working reliably" v3, meaning it ships with all the substantive v2 features that matter for listeners and curators, without v2's configurable-everything complexity.

**Explicit DROPs:** admin panel, queue display (up-next), Camelot key wheel / harmonic mixing tools, configurable-everything options.
**Explicit KEEPs:** track download (overriding earlier recommendation to drop).

v3.0 MVP now covers:

1. **Listen** — HLS streaming, 11 stages (10 Plex-backed + Bus mystery), crossfade, controls.
2. **Know which stage** — per-stage gradients/accents/icons + Plex-driven descriptions.
3. **History of past played tracks** — SQLite-backed log with timeline UI.
4. **History of latest additions per stage** — v3 observes Plex over time, logs first-seen-in-stage events.
5. **Live listener count** — per-stage real-time, WebSocket.
6. **Artist / album / label info pages** — from Plex + Last.fm + MusicBrainz enrichment.
7. **Similar artists** — from Plex artist data, enriched by Last.fm.
8. **Track download** — serve the source audio file on request.

Everything else is v3.1+ or DROP.

## Legend

| Tag | Meaning |
|---|---|
| **MVP** | Ships in v3.0. The quality bar is high, not "minimum possible." |
| **v3.1+** | Scheduled next: **v3.1 Wrapped → v3.2 curator dashboard + advanced analytics → v3.3 artist graph + more**. |
| **LATER** | Good idea, no scheduled slot yet. Revisit when foundation is solid. |
| **DROP** | Don't build. Confirmed DROP or feature-creep pattern. |

Source tags: **[v1]** · **[v2]** · **[new]**.

---

## 1. Audio playback & streaming

| Feature | Source | Triage | Notes |
|---|---|---|---|
| HLS streaming (3-sec AAC 128 segments) | [new] | MVP | Design doc locked. |
| 11 stages (10 Plex + Bus mystery) | [v1][v2] | MVP | Mapping locked in design doc. |
| Crossfade on stage switch (client-side, fixed curve) | [v1][v2] | MVP | Port v1's `useCrossfade.js`. One curve. |
| Volume control + mute, persisted | [v1][v2] | MVP | localStorage. |
| Play/pause | [v1][v2] | MVP | Space key. |
| Stream error recovery + reconnect | [v1][v2] | MVP | HLS already tolerant, retry m3u8 on fail. |
| Background audio (tab backgrounded) | [v1][v2] | MVP | Browser default. |
| Adaptive stream quality (128/192/320/FLAC) | [v2] | DROP | One quality (AAC 128) for a personal radio. |
| Volume normalization | [v2] | DROP | Plex library is pre-normalized. |
| 5 crossfade curves | [v2] | DROP | Pick one. |
| Prebuffer duration setting | [v2] | DROP | Internal constant. |

## 2. Stages & navigation

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Browse & Switch (viewing ≠ playing) | [v1] | MVP | v1's best UX invention. Keep. |
| Now-playing strip when exploring another stage | [v1] | MVP | |
| Previous/next stage (arrows + swipe) | [v1][v2] | MVP | |
| Number keys jump to stage | [v1][v2] | MVP | 1–9 maps to first nine stages, 0 can map to 10th. |
| Single stage picker layout (sidebar + mobile drawer) | [v1] | MVP | Not three layouts — one. |
| Hover preview popover (cover + artist + title, 500ms delay) | [v1] | MVP | |
| Per-stage accent + gradient + icon | [v1][v2] | MVP | Port `streamMeta.js`. Descriptions from Plex. |
| Live status indicator (is this stage broadcasting?) | [v2] | MVP | HLS `manifest updated-at` is the signal. |
| Stage assignment admin UI | [v2] | DROP | `stages.ts` is the source. |
| 3 layouts for stage picker (grid/scroll/list) | [v2] | DROP | One. |

## 3. Now-playing display & metadata

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Cover, title, artist, album, year, duration | [v1][v2] | MVP | |
| Track progress bar | [v1][v2] | MVP | |
| "Was playing" toast on return to stage | [v1] | MVP | v1's great pattern. |
| "Playing" cyan pill badge on cover | [v1] | MVP | |
| Loading spinner on switch | [v1] | MVP | |
| Equalizer bars in sidebar | [v1] | MVP | Port v1's component. |
| Skeleton while loading | [v1] | MVP | |
| Track metadata badges (BPM, key, genre, label, year) | [v2] | LATER | BPM/key require deeper metadata extraction. Year/label/genre arrive via Plex metadata — show selectively. |
| Camelot key display | [v2] | DROP | DJ-specific, not listener-facing. |

## 4. Search

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Global ⌘K fuzzy search | [v2] | v3.2 | Once enrichment + history exist, there's enough to search. |
| Search tabs (tracks/artists/albums/labels) | [v2] | v3.2 | |

## 5. Artist / album / label info

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Artist drawer (bio + similar, quick-access from now-playing) | [v1] | MVP | v1 pattern. |
| Full artist page (bio, photo, tags, external links, library tracks) | [v2] | MVP | Dedicated route. |
| Artist similar-artists list (clickable if in library) | [v1][v2] | MVP | From Plex + Last.fm. |
| Album page (cover, year, label, tracks in library, total plays once history exists) | [v2] | MVP | Basic version day one. |
| Label page (label name, artists under it, tracks in library) | [v2] | MVP | Basic version day one. |
| Artist external links (Spotify/Bandcamp/SoundCloud/RA/Wiki) | [v2] | MVP | From enrichment. |
| Artist country with flag | [v2] | MVP | From MusicBrainz. |
| New artist badge (🆕 first time seen) | [v2] | MVP | Derivable once history logging exists. |
| Artist members/groups | [v2] | MVP | Where MusicBrainz has it; hide if not. |
| Last.fm enrichment (bio, tags, similar) | [v2] | MVP | Primary source, cached in SQLite. |
| MusicBrainz enrichment (MBID, country, relationships) | [v2] | MVP | Fallback/supplement. |
| Discogs enrichment | [v2] | DROP | Last.fm + MB cover 95%. |
| Wikidata enrichment | [v2] | DROP | Same. |
| TheAudioDB enrichment | [v2] | DROP | Same. |
| Artist timeline of library events | [v2] | v3.2 | Needs time-series data accumulated. |
| Artist Last.fm listener + scrobble counts | [v2] | LATER | Vanity. |
| Artist-level 7×24 play heatmap | [v2] | LATER | Niche. |
| Artist stage presence bars | [v2] | MVP | Simple: "appears on 3 stages: Fontanna, Palac Dance, Etage 0." |

## 6. History of played tracks

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Auto-log every play (timestamp, stage, track) to SQLite | [v2] | MVP | First analytics primitive. |
| Timeline view (day-grouped, reverse-chronological) | [v2] | MVP | The history page. |
| Filter by stage | [v2] | MVP | |
| Filter by time range | [v2] | MVP | Presets + custom date. |
| Filter by artist (type-ahead) | [v2] | MVP | |
| Stats sidebar (today/week/month totals, top track) | [v2] | MVP | Derived queries. |
| Data export: history CSV | [v2] | MVP | Trivial. Curator value. |
| Re-listen historical track overlay player | [v2] | DROP | Requires on-demand playback + likely legal concerns. The download button covers this. |
| Calendar heatmap of plays | [v2] | v3.2 | Beautiful but needs months of data. |
| Table view with sortable columns | [v2] | v3.2 | |
| Grid view (album cards) | [v2] | LATER | Redundant with timeline. |
| Data export: stats PDF | [v2] | DROP | Browser print works. |

## 7. History of latest additions per stage (Discovery feed)

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Log first-seen-in-stage events to SQLite | [new] | MVP | v3 polls Plex every 60s for each stage's playlist, diffs, logs adds. This is the only way — user resets tiers 1-2 so Plex doesn't preserve history. |
| Recent additions feed per stage | [v2] | MVP | "New in Palac Dance this week" etc. |
| Global "recently added across all stages" feed | [v2] | MVP | Reverse-chronological across all stages. |
| Filter by stage, time range | [v2] | MVP | |
| Discovery actions (play, go to artist, download) | [v2] | MVP | Matches the Discovery scope user asked for. |
| Discovery velocity sparkline (tracks/week) | [v2] | v3.2 | After weeks of data exist. |
| Discovery stats sidebar (velocity, most-added artist, new artists count) | [v2] | v3.2 | Same. |

## 8. Live listener count

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Per-stage live listener count | [v2] | MVP | Count active HLS segment requesters per stage. In-memory, no persistence. |
| Total live listeners across stages | [v2] | MVP | Sum. |
| Real-time update via WebSocket | [v2] | MVP | Pushed from engine. |
| Listener milestone toast ("100 live on Bermuda!") | [v2] | MVP | Round-number triggers. Delight. |
| Geographic listener distribution (country-level) | [v2] | v3.2 | Privacy-conscious. Country only, no coords. |
| Stage online/offline toast | [v2] | LATER | Rare event. |

## 9. Track download

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Download source audio file | [v2] | MVP | **User override.** Serve file from Plex library via HTTPS with proper `Content-Disposition`. Accessible from track detail, now-playing menu, and history rows. |

## 10. Statistics / top rankings (listener-facing basics)

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Overview stats (tracks, artists, albums, plays) | [v2] | MVP | Simple aggregates. Appears on /stats page. |
| Top artists ranking (by plays, library count) | [v2] | MVP | |
| Top tracks ranking (by plays) | [v2] | MVP | |
| Top albums ranking | [v2] | MVP | |
| Top labels ranking | [v2] | MVP | |
| Stage distribution (tracks + plays per stage) | [v2] | MVP | Bar chart. |
| Decade breakdown | [v2] | v3.2 | |
| Label distribution treemap | [v2] | v3.2 | Fancier viz than the basic ranking. |
| Genre evolution | [v2] | v3.2 | Needs genre tags accumulated. |
| BPM histogram | [v2] | LATER | Needs reliable BPM data. |
| Track length distribution | [v2] | LATER | Low-signal. |
| Geographic artist-country map | [v2] | v3.2 | |
| Cross-stage artist analysis | [v2] | v3.2 | |
| Replay value ranking | [v2] | v3.2 | |
| Stage transition Sankey | [v2] | DROP | Niche. |
| Diversity / concentration / label-loyalty metrics | [v2] | DROP | Too many saying the same thing. |
| Curator "set compatibility" / energy curve / freshness score | [v2] | LATER | DJ tool territory. |
| Dashboard filters (time/stage/genre/country) | [v2] | MVP | Filter UI for the basic stats above. |

## 11. Curator dashboard & digging (curator-only)

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Personal dashboard landing page | [v2] | v3.2 | Curator-facing hub after public features stabilize. |
| Digging calendar heatmap (GitHub-style) | [v2] | v3.2 | Needs v3 to snapshot stage-addition events (already in MVP). |
| Digging streaks | [v2] | v3.2 | |
| Digging session clustering | [v2] | LATER | Complex narrative logic, defer. |
| Digging pattern analysis (day/time) | [v2] | v3.2 | |
| Automated insight generation | [v2] | v3.2 | |
| Genre-shift detection | [v2] | v3.2 | |
| Neglected stage alerts | [v2] | v3.2 | |
| Discovery pace metrics | [v2] | v3.2 | |

## 12. Wrapped / year-in-review

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Annual Wrapped (animated cards) | [v2] | v3.1 | Needs ~1 year of history. |
| Wrapped shareable PNG | [v2] | v3.1 | |
| Monthly recap | [v2] | v3.1 | 1st of month, smaller wrapped. |
| Multi-year archive / comparison | [v2] | LATER | Needs multiple wrapped cycles. |

## 13. Artist graph / visualization

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Force-directed artist similarity graph | [v2] | v3.3 | Big undertaking. After wrapped + curator dashboard. |
| Graph zoom/pan/search/filters/color-modes/size-modes/layouts | [v2] | v3.3 | All part of the graph feature. |
| Ego graph (zoom to single artist + neighbors) | [v2] | v3.3 | |
| Graph stats panel (centrality, clusters, isolated artists) | [v2] | v3.3 | |

## 14. Mobile UX

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Mobile mini player (64px fixed bottom) | [v2] | MVP | |
| Full-screen player (swipe up to expand) | [v2] | MVP | |
| Horizontal swipe to switch stages | [v1] | MVP | Port v1. |
| Swipe up/down on player | [v2] | MVP | |
| Streams drawer (hamburger) | [v1] | MVP | Port v1. |
| Bottom tab bar for secondary routes | [v2] | MVP | Required given we now have /history, /discovery, /stats, /artists. |
| Haptic feedback (`navigator.vibrate(10)`) on stage switch / play | [v2] | MVP | Tiny code, polish win. |
| Long-press album art → context menu | [v2] | DROP | |
| Pull-to-refresh | [v2] | DROP | |
| Pinch-to-zoom on graph | [v2] | DROP | No graph in MVP. |

## 15. Keyboard & accessibility

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Space, ←→, ↑↓, M, 1–9, Enter, Esc | [v1][v2] | MVP | Full port of v1's shortcuts + extensions. |
| ⌘K search | [v2] | v3.2 | With search. |
| F fullscreen | [v2] | LATER | Browser F11 covers it. |
| ? shortcut cheat sheet | [v2] | LATER | Polish. |
| ARIA labels throughout | [v2] | MVP | |
| Focus indicators visible (accent color) | [v2] | MVP | |
| Screen reader announcements (aria-live on track change) | [v2] | MVP | |
| Semantic HTML | [v2] | MVP | |
| WCAG AA contrast | [v2] | MVP | |
| Reduce motion | [v2] | MVP | `prefers-reduced-motion` default. |

## 16. Settings & preferences

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Volume persisted across sessions | [v1] | MVP | localStorage, invisible. |
| Last-viewed stage resumes | [v1] | MVP | localStorage, invisible. |
| Reduce motion toggle | [v2] | MVP | |
| Dedicated Settings screen | [v1][v2] | v3.2 | Only if more than 3 toggles exist by then. |
| Crossfade/quality/theme/layout/font/shape configurables | [v2] | DROP | All of them. Ship one great default of each. |
| Debug mode / latency hint / reconnect interval | [v2] | DROP | Internals. |

## 17. Visualizer

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Any audio visualizer | [v2] | LATER | Cool demo, rarely actually watched. Skip v3.0. |
| 8 visualizer types + all their settings | [v2] | DROP | One great one if we ever add it. |

## 18. Queue / up-next

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Queue display (upcoming tracks) | [v2] | DROP | **User drop.** Radio = surprise. |
| Queue reorder / remove / skip | [v2] | DROP | |

## 19. Notifications / toasts

| Feature | Source | Triage | Notes |
|---|---|---|---|
| "Was playing" toast | [v1] | MVP | |
| New artist toast ("🆕 first time: X → stage") | [v2] | MVP | With history + enrichment. |
| Listener milestone toast | [v2] | MVP | |
| Stream reconnecting toast | [v2] | MVP | |
| Stage online/offline toast | [v2] | LATER | |
| Desktop push (PWA) | [v2] | LATER | Low-benefit, high opt-in friction. |
| Notification preferences panel | [v2] | v3.2 | With Settings screen. |

## 20. Social & sharing

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Share station (navigator.share) | [v1] | MVP | v1 has it. |
| Share deep-link to stage (`/s/palac-dance`) | [v2] | MVP | |
| Share deep-link to track | [v2] | MVP | Track detail pages exist in MVP. |
| Share deep-link to artist | [v2] | MVP | Artist pages exist in MVP. |
| Open Graph preview cards | [v2] | MVP | Rich previews in iMessage/Slack/Twitter. |
| Share Wrapped PNG | [v2] | v3.1 | |
| Copy track info to clipboard | [v2] | MVP | Cheap polish. |

## 21. Admin

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Protected admin panel | [v2] | DROP | **User drop.** SSH + git + systemctl. |
| Stage start/stop/toggle UI | [v2] | DROP | |
| Queue management UI | [v2] | DROP | |
| Force Plex sync | [v2] | DROP | Live API, no sync. |
| Enrichment queue admin | [v2] | LATER | CLI flag if needed, not UI. |
| System monitoring dashboard | [v2] | DROP | `journalctl --user` + health endpoint. |

## 22. Branding & visual identity

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Dark theme, violet undertone | [v1][v2] | MVP | v1 base colors already great. |
| Per-stage gradients + accents | [v1] | MVP | Port. |
| Glass morphism on player bar | [v2] | MVP | Backdrop-blur. |
| Bus mystery card | [v1] | MVP | Iconic, port verbatim. |
| Witty empty-state copy | [v2] | MVP | Microcopy. Cheap, high impact. |
| Typography roles (2 fonts: one display + one mono for metadata) | [v2] | MVP | Pick 2, not 4. |
| Scrollbar styling | [v2] | MVP | Tiny CSS. |
| Animated mesh gradient on About page | [v2] | LATER | v1's InfoDialog works. |
| "ANTI-ALGORITHM" badge | [v2] | LATER | Optional brand. |
| GAENDE title first-load animation | [v2] | LATER | Delight polish. |
| Pulsing loading waveform (not spinner) | [v2] | LATER | v1 spinner works. |
| OLED / Midnight Blue theme variants | [v2] | DROP | One dark theme. |
| Album art shape setting | [v2] | DROP | |

## 23. PWA / installable

| Feature | Source | Triage | Notes |
|---|---|---|---|
| PWA manifest (install to home screen) | [v1][v2] | MVP | |
| Service worker (app shell cache) | [v2] | MVP | Vite PWA plugin. |
| Media Session API (lockscreen controls) | [v1][v2] | MVP | Port v1. |
| Background audio | [v1][v2] | MVP | Browser default. |
| Offline shell (UI loads offline, streams obviously don't) | [v2] | MVP | |
| App shortcuts (long-press icon) | [v2] | LATER | Nice, low priority. |
| Icon maskable (OS-shape matching) | [v2] | MVP | Cheap to include. |

## 24. About / info

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Info dialog (v1-style: Pavoia GIF, bio, socials, share) | [v1] | MVP | Port verbatim. |
| Pavoia festival link | [v1][v2] | MVP | |
| SoundCloud + Instagram links | [v1][v2] | MVP | |
| Geographic affiliations (cities) | [v2] | LATER | Nice personal touch. |
| Cinematic About page (dedicated route with mesh gradient) | [v2] | LATER | v1 dialog is enough. |
| Stage preview cards on About | [v2] | DROP | Duplicates main UI. |

## 25. Plex integration

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Live Plex API playlist reads (60s poll) | [new] | MVP | |
| Plex token from env var | [new] | MVP | |
| Plex cover art proxy | [v1] | MVP | Port v1's `/api/cover-proxy`. |
| Plex artist metadata via API | [v1] | MVP | |
| Stage → playlist mapping in `stages.ts` | [new] | MVP | Audit already done. |
| Dynamic stage titles/descriptions from Plex summary | [new] | MVP | |
| Plex webhook for instant updates | [new] | LATER | Nice upgrade over 60s poll. |

## 26. Performance

| Feature | Source | Triage | Notes |
|---|---|---|---|
| Image blur placeholders | [v2] | MVP | |
| Multi-size album art (responsive) | [v2] | MVP | Plex image sizing params. |
| Route-level code splitting | [v2] | MVP | TanStack Router. |
| Link prefetch on hover | [v2] | MVP | TanStack Router `preload`. |
| Canvas pause when tab hidden | [v2] | MVP | Pattern for any animated background. |
| WebSocket exponential backoff | [v2] | MVP | |
| Optimistic UI updates | [v2] | MVP | TanStack Query default. |
| Virtual scrolling (long lists) | [v2] | v3.2 | Once history + enrichment make lists big. |
| Multi-tab state sync | [v2] | DROP | |

---

## v3.0 MVP SUMMARY (what ships at cutover)

### The player
11 stages (10 Plex-backed + Bus mystery), HLS streaming, crossfade, volume/mute/play/pause, Browse & Switch, now-playing strip when exploring, "was playing" toast, per-stage accents/gradients/icons, dynamic descriptions from Plex, hover preview, mobile mini + full-screen + swipe + drawer + bottom tab bar, keyboard shortcuts, PWA install + offline shell + Media Session + background audio, info dialog, Bus mystery, track download, share (native + deep-links + OG cards).

### Metadata depth
Artist pages (bio, photo, country, external links, library tracks, stage presence, similar artists) from Plex + Last.fm + MusicBrainz enrichment cached in SQLite. Album pages (cover, year, label, tracks). Label pages (artists + tracks). Search deferred to v3.2.

### History + discovery
Every play logged. Every Plex playlist addition observed and logged (v3 polls every 60s and diffs). Timeline view with filters (stage, time, artist). Discovery feed per stage + global. CSV export. New-artist badge.

### Live listener count
Per-stage + total, real-time via WebSocket. Milestone toasts.

### Engine
One Node process per role (engine + web). Engine manages 9 ffmpeg instances → HLS, reads Plex API + filesystem directly, logs plays + additions to SQLite, counts listeners from HLS request headers, runs Last.fm + MusicBrainz enrichment as background workers. Web serves SPA + static HLS + REST + WebSocket proxy.

### Deploy
GitHub Actions → build → rsync → `systemctl --user reload` both units. Zero-drop engine reload. Parallel `v3.nicemouth.box.ca` cutover.

## v3.1+ ROADMAP (next)

- **v3.1** — **Wrapped**: annual cards, monthly recap, shareable PNG. Needs ~year of history.
- **v3.2** — **Curator dashboard + advanced analytics**: digging calendar, streaks, patterns, automated insights, genre-shift detection, discovery velocity, replay rankings, decade/label/geo distributions, time-of-day heatmap, search, Settings screen with notification preferences, virtual scrolling.
- **v3.3** — **Artist graph**: force-directed similarity visualization with filters, layouts, ego graph, stats panel.
- **v3.x** — Plex webhooks (instant add detection), PWA app shortcuts, cinematic About page, animated mesh gradient, possibly Postgres migration (only if SQLite struggles).

## DROP PILE (do not build)

Feature-creep patterns from v2: admin UI, queue display, Camelot/harmonic DJ tools, configurable-everything (5 crossfade curves, 8 visualizers, 3 themes, 3 layouts, font/shape/latency/debug settings), multi-tab sync, track-download-plus-overlay-player (just download is enough), stage transition Sankey, overlapping concentration metrics, Discogs/Wikidata/TheAudioDB (marginal over Last.fm+MusicBrainz), long-press album menus, pull-to-refresh, stats PDF export.

---

## Reality check on the expanded MVP

Honest estimate: v3.0 as scoped is roughly **2–3× the code** of v1. But it's roughly **1/3 the code** of what v2 was chasing. That's the sweet spot — genuinely substantive on day one, but still one coherent thing a solo maintainer can reason about six months later.

The implementation should sequence inside MVP (ship each phase to parallel subdomain, test before moving on):

1. **Engine + player** — 11 stages streaming, basic now-playing. That's the cutover floor if timeline squeezes.
2. **Metadata depth** — artist/album/label pages + enrichment workers. Independent of engine once Plex API + SQLite schema exist.
3. **Listener counting** — WebSocket + per-stage counts + milestone toasts. Independent.
4. **History logging** — SQLite plays table + timeline UI + filters + CSV export. Independent.
5. **Discovery feed** — additions logging + feeds + filters. Uses same SQLite.
6. **Polish** — OG cards, PWA, haptics, track download, all keyboard + a11y. Cross-cutting.

If any phase gets gnarly, it drops to v3.1 without breaking the ones before it. That's the escape valve.
