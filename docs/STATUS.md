# Pâvoia v3 — Status & Plan

_Last updated: 2026-05-07. Branch: `fix/web-readability-and-sticky-footer`._

This file is the running source of truth for what's shipped, what's
in flight, and what's queued. It supersedes nothing — `docs/SLIM_V3.md`
remains the canonical MVP scope, and `docs/WEEK0_LOG.md` remains the
evidence log for the 16 locked engineering requirements.

---

## TL;DR

The engine has been live on Whatbox for two weeks and is producing
HLS for all 10 audio stages. The web SPA is feature-complete for
v3.0 and went through a major visual rework over the last two days
(eye-on-home, pavoia.com font palette, no-scroll layout). What
remains for the public cutover at `v3.nicemouth.box.ca` is mostly
polish, the merge gate on the current branch, and the DNS flip.

---

## Engine — `apps/engine`

| Item | State |
|---|---|
| Plex client + 10 stage supervisors | ✅ shipped |
| ffmpeg-per-track lifecycle, fallback loop | ✅ shipped |
| Hono HTTP: `/api/health`, `/api/stages`, `/api/stages/:id/now`, `/hls/*` | ✅ shipped |
| SPA static handler (`/assets/*` + dist-root files like `/pavoia-logo.gif`) | ✅ shipped |
| `cron + nohup + watchdog` deploy plumbing | ✅ shipped on Whatbox |
| Orphan-ffmpeg reaper on bootstrap (issue #19) | ✅ shipped |
| `log-rotate.sh` copytruncate rotation (issue #19) | ✅ shipped |
| Plex thumb proxy (`/api/plex/thumb/:key/:id`) | ✅ shipped |
| Plex artist endpoint (`/api/plex/artist/:ratingKey`) | ✅ shipped |
| Test coverage | 303 tests, all green |

Open engine items:
- Issue #19 had a few polish items closed in PR #18. No critical
  follow-ups are tracked.
- Hex-color validation on `Stage.gradient.*` (CR advisory finding,
  not blocking) — could land as a small follow-up if we ever expose
  Stage construction to user-supplied data. Currently all colors
  are hardcoded by us.

---

## Web SPA — `apps/web`

### Shipped this session

| Slice | What changed |
|---|---|
| Persistent audio | `<audio>` + Hls.js singleton in `PlaybackProvider`; survives navigation |
| Cover art | `<CoverImage>` component, lazy fallback, Plex thumb via engine proxy |
| Atmospheric backdrop | `<StageAtmosphere>` with motion library — blurred ken-burns cover + breathing gradient orbs |
| HLS resilience | maxBufferLength 60, 8 retries, MAX_FATAL_RECOVERY_ATTEMPTS=5 with reset on `playing` |
| Visual identity | Animated eye GIF as home hero (replaced typed `PAVOIA` wordmark) |
| Typography | 4-font palette: Belleza (wordmark), Caveat (emotional headlines), Sora (UI), JetBrains Mono (captions). Instrument Serif dropped. |
| Favicon + tab title | Pulled apple-icon-180x180 from pavoia.com, set as favicon + apple-touch-icon. Tab title "Pâvoia · gaende's webradio". |
| About modal | Curator's first-person note (6-year listening habit), socials in two side-by-side icon-only groups: pâvoia (Instagram, SoundCloud, web) + gaende (Instagram, SoundCloud, Spotify). v3 caption + Bus stage hint dropped. |
| Sidebar | "PÂVOIA" wordmark in Belleza, "made by gaende" → clickable link to About, emoji icons stripped from stage rows |
| Stage rename | "Bermuda Before 18:00 / Oaza" → "Bermuda / Oaza Afternoon", "Bermuda (18:00–00:00)" → "Bermuda Early Night" |
| Layout | `min-w-0` on main column, `h-dvh overflow-hidden` root, sidebar shrinks to leave room for persistent player bar — no scrollbars anywhere |
| Cover sizing | `width: min(60vw, 38vh, max(0px, calc(100dvh - 540px)))` — fits viewport, EQ overlay anchors to cover not container |
| Contrast | `--color-text-faint` bumped from #4f3d30 (~1.6:1) to #7a6555 (~3.0:1) for readable metadata |
| Accessibility | focus-visible ring styles on the new buttons; aria-hidden on decorative emoji |

### Web SPA unfinished items

| Item | Notes |
|---|---|
| Browser-tab titles per stage | Currently shows the same site title; could update to "Pâvoia · {stage title}" when a stage is active |
| Volume control | Not in v3.0 scope — listener uses OS / browser controls |
| Stage transition crossfade | Out of scope — radio plays one track at a time per stage |
| Mobile drawer focus trap | Could verify; currently the dialog uses native `<dialog>` which traps |
| Keyboard shortcuts | Out of v3.0 scope (would land in 3.1) |
| Service Worker / PWA | Out of v3.0 scope (3.x) |

---

## Visual system

After this session's pass, the design tokens are:

**Colors** (against bg #080505):
- `--color-text` #e8ddd4 — primary text (~14.7:1 contrast, AAA)
- `--color-text-soft` #8f7a6a — secondary (~5.5:1, AA)
- `--color-text-faint` #7a6555 — metadata (~3.0:1, AA Large)
- `--color-accent` #e85020 — primary accent (red-orange)
- `--color-amber` for warm warnings / Bus stage hints

**Typography** (4 fonts):
| Token | Font | Where |
|---|---|---|
| `font-display` | Belleza | PÂVOIA wordmark (Sidebar, MobileHeader) |
| `font-script` | Caveat | Big emotional headlines: home tagline, stage h1, Bus h2, ArtistDrawer h2 |
| `font-sans` | Sora | UI default — body, track titles, descriptions, mid-size italics |
| `font-mono` | JetBrains Mono | Captions only: `//`, `$`, time codes, on-air markers |

**Animations:**
- `animate-glow-pulse` — slow ambient breath behind the home eye (6s, scale 1.55↔1.7, opacity 0.75↔1)
- `animate-mood-shift` — 80s gradient drift on home backdrop
- `animate-blink` — 1.2s on-air dot, "▸" cursor
- `animate-eq-bar` — 1s eq bars when audio is playing

---

## Deployment

- Engine running on Whatbox under `cron @reboot start-engine.sh` + `* * * * * watchdog.sh`
- Logs: `~/webradio-v3/logs/engine.log`, `watchdog.log` (copytruncate rotated)
- HLS output: `/dev/shm/1008/radio-hls/<stage>/`
- Web served by the engine's `/assets/*` + SPA fallback handler
- SSH tunnel for dev: `ssh -N -L 20100:127.0.0.1:20100 whatbox`

**Cutover to public:** `v3.nicemouth.box.ca` not yet routed at the
Whatbox edge. v1 (radio.nicemouth.box.ca) still serves listeners.

---

## Branch state — `fix/web-readability-and-sticky-footer`

Currently ahead of `main`. PR lands via the standard triple-signoff flow:

To open the PR:
1. `gh pr create --draft --fill`
2. Wait for the CodeRabbit GitHub App + Codex reviews
3. Address Critical / [P1] / Major findings; advisory findings batch
4. `gh pr ready` once clean
5. Triple-signoff merge gate (Claude + Codex + CodeRabbit + CI)
6. `gh pr merge --squash --delete-branch`

Outstanding CR pre-push findings on this branch (all advisory, not
blocking under the severity gate in CLAUDE.md):
- `Stage.gradient.*` hex-color branded type / runtime validation
- One or two `potential_issue` style preferences

---

## What's next, in order

1. **Land this branch.** Open the PR, run the triple-signoff gate,
   merge to `main`. The visual rework is sitting in a 16-commit
   branch — getting it into `main` is the next mechanical step.
2. **Public cutover.** Wire `v3.nicemouth.box.ca` at the Whatbox
   edge, point DNS, soft-launch. Keep v1 alive in parallel until v3
   has been audible for a week with no incidents.
3. **Listen test on actual phone.** Verify HLS playback on iOS
   Safari + Chrome Android, including background-tab continuation
   and Add-to-Home-Screen. The Playwright runs are visual only.
4. **Stretch:** per-stage browser tab titles; tighter mobile drawer
   focus-trap audit.

The 4-week SLIM_V3 plan called for Week 4 = cutover. We're around
end-of-Week-2 + the visual rework + hardening, so the public
cutover is the meaningful next milestone.
