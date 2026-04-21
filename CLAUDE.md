# CLAUDE.md — onboarding for a fresh session

You are working on **pavoia-webradio-v3**, a Plex-driven HLS radio running on a Whatbox seedbox. This doc gets you from zero context to "I know what to build next" in ~5 minutes.

---

## 1. Read this first, in this order

1. **`CLAUDE.md`** (this file) — orientation
2. **`docs/SLIM_V3.md`** — canonical MVP feature scope for v3.0
3. **`docs/WEEK0_LOG.md`** — 16 locked engineering requirements (A–P), each backed by a prototype verified on Whatbox
4. **`docs/DESIGN_V3.md`** — architecture + Plex audit. Sections marked "superseded" defer to SLIM_V3.
5. **`docs/ENG_REVIEW_V3.md`** — full eng review + Codex challenge resolution. Read if you need the *why* behind a call.
6. **`docs/TODO_V3.md`** — reference only, historical feature triage reasoning.

If there's ever a conflict between docs, `SLIM_V3.md` + `WEEK0_LOG.md` win. Everything else is history or context.

---

## 2. What this project IS

- A private personal webradio for **Gaende** (curator) and the Pavoia venue community (listeners).
- Replaces two prior versions (`pavoia-webradio` v1 and `pavoia-webradio-v2`) both still running on Whatbox.
- Runs on **orange.whatbox.ca** (Gentoo seedbox, 64-core EPYC, 500GB RAM, no systemd, shared host).
- Plex library at `/home/yolan/files/plex_music_library/opus/` is the source of truth for all music.
- 11 stages: 10 audio (each mapped to a Plex playlist) + 1 "Bus" mystery (UI easter egg, no audio).

## 3. Working cadence (explicit user preference)

**Work slowly. One solid step at a time. Verify before moving on. Never have to backtrack.**

Concretely:
- Don't batch multiple steps into one turn.
- Run the code. See the output. Confirm it matches expectation.
- When a step is approved, propose the next *single* step.
- If a step reveals an unexpected issue, surface it — don't work around it silently.
- Completeness at the step level, not at the session level.

This overrides any default "boil the lake in one shot" bias. The user has been burned twice (v1 lived, v2 got abandoned mid-rewrite) and is rebuilding the foundation carefully on purpose.

## 4. Status checkpoint (as of 2026-04-21)

- ✅ **Week 0** done. 4 prototype+verification steps on real Whatbox + Plex data. 16 locked requirements (A–P in `docs/WEEK0_LOG.md`).
- ✅ **Monorepo scaffold** created. `apps/engine`, `apps/web`, `packages/shared` each compile empty. Stages config already populated with verified Plex ratingKeys.
- ⏳ **Week 1** starting. Engine MVP: Plex client → stage supervisor → per-track ffmpeg → HLS output.

No production code exists yet. Every implementation choice is recorded in WEEK0_LOG.md with evidence.

## 5. Stack (locked 2026-04-21)

- **Language:** TypeScript end-to-end (Node 22 LTS, pinned via mise to 22.22.2 on Whatbox).
- **Engine:** Node 22 + Hono for internal HTTP + `child_process.spawn('ffmpeg')` per track.
- **Web:** Vite + React 19 + TanStack Router + TanStack Query + Tailwind 4 (SPA, served by Hono static handler).
- **Audio:** HLS (AAC 128 kbps, 3-sec segments, rolling 6-segment window). ffmpeg does the encoding, Hono serves the `.m3u8` + `.ts` files.
- **State:** in-memory only in v3.0. No Postgres, no Redis, no Meilisearch, **no SQLite** in the MVP.
- **Deploy:** Whatbox seedbox via `@reboot` cron + `nohup` + cron-watchdog pattern (no systemd on Whatbox — verified Week 0 Step 2).

## 6. The 11 stages (locked, in `packages/shared/src/stages.ts`)

| Order | ID | Plex ID | Tracks | What it is |
|---|---|---|---|---|
| 0 | `gaende-favorites` | 147167 | 245 | 5-star rated tracks, curator picks |
| 1 | `opening` | 162337 | 502 | Warmup, first tracks of the night |
| 2 | `ambiance-safe` | 145472 | 70 | Chill, downtempo |
| 3 | `bermuda-day` | 146377 | 1,113 | Lake stage, daytime |
| 4 | `bermuda-night` | 145468 | 2,040 | Lake stage, sunset→midnight |
| 5 | `fontanna-laputa` | 145469 | 660 | Afternoon house |
| 6 | `palac-slow-hypno` | 146686 | 1,094 | Main stage, FEEL mood |
| 7 | `palac-dance` | 145470 | 1,625 | Main stage, DANCE mood |
| 8 | `etage-0` | 145471 | 174 | Fast floor, hard techno |
| 9 | `closing` | 162463 | 88 | Beautiful closers |
| 10 | `bus` | null | — | Mystery, UI card only, no audio |

Titles and descriptions at runtime come live from each Plex playlist's `summary` field. Icons, gradients, and accent colors are static (ported from v1's `streamMeta.js`).

## 7. The 16 locked requirements (at-a-glance)

See `docs/WEEK0_LOG.md` for full context + evidence.

- **A–D (Plex paths):** Direct fs reads; UTF-8 end-to-end; ffmpeg concat single-quote escape rule `' → '\''` (verified); single library root at `/home/yolan/files/plex_music_library/opus/`.
- **E–J (deploy):** No systemd — use cron `@reboot` + `nohup` + cron-minute watchdog; HLS at `/dev/shm/1008/radio-hls/<stage>/`; env via `source` in wrapper scripts; logs to `~/webradio-v3/logs/`; Node 22.22.2 via mise; watchdog restarts on 3 consecutive HTTP 000 (not on 5xx).
- **K–P (ffmpeg):** One ffmpeg per track with `-hls_flags +append_list+omit_endlist+delete_segments`, `-hls_time 3 -hls_list_size 6`; segment filename `seg-%05d.ts`; track boundary = ffmpeg `exit` event in Node; empty stage → loop `curating.aac`; encoding fixed at AAC 128 stereo 44.1kHz.

## 8. Whatbox constraints (cheat sheet)

- SSH access via `ssh whatbox` (key-based, configured in `~/.ssh/config`). User = `yolan`, UID = `1008`.
- **No systemd.** No `systemctl`, no `journalctl`, no `/run/user/$UID`.
- **No process managers** (pm2, supervisord, s6, etc. not installed).
- Process management: `@reboot` crontab entries + `nohup` + `* * * * *` watchdog.
- tmpfs: `/dev/shm/` (252 GB shared). Our files go under `/dev/shm/1008/`.
- Plex API: `http://127.0.0.1:31711` (NOT the standard :32400). Token from `~/Library/Application Support/Plex Media Server/Preferences.xml` via `PlexOnlineToken` attribute.
- Whatbox edge TLS handles `*.nicemouth.box.ca` subdomains. v3 will claim `v3.nicemouth.box.ca`.
- Parallel subdomain cutover: v1 keeps serving `radio.nicemouth.box.ca` until v3 is verified; then DNS flips.

## 9. Week 1 implementation plan (from SLIM_V3.md)

Order:
1. Engine bootstrap: typecheck passes, dev server starts, writes "hello" log. **This is the first task.**
2. Plex client (`packages/engine/src/plex/`): `fetchPlaylist(ratingKey)` returns `Track[]`.
3. Stage supervisor (`packages/engine/src/stages/`): spawns one ffmpeg per track.
4. HLS output verified in browser: point VLC or `hls.js` at the m3u8, hear audio.
5. Hono HTTP: `/api/health`, `/api/stages`, `/api/stages/:id/now`, `/hls/*` static.
6. Deploy shell: wrapper scripts + cron setup + watchdog port from v2.
7. Ships to `v3.nicemouth.box.ca`. Engine audible via curl+VLC. No UI yet.

Then Week 2 (web UI), Week 3 (polish + a11y + PWA), Week 4 (cutover).

**Start each task with: read the code, propose exactly what you'll add, wait for approval, implement, verify with a concrete test (not just typecheck), then propose the next task.**

## 10. Skills routing (gstack)

When the user's request matches one of these, invoke it via the Skill tool first:
- New feature ideas / brainstorming → `office-hours`
- Bugs / errors / unexpected behavior → `investigate`
- Ready to ship → `ship`
- Check the UI / dogfood → `qa`
- Pre-landing code review → `review`
- "Review the plan" / architecture lock-in → `plan-eng-review`

Don't invoke them preemptively. Match them to user intent.

## 11. Things NOT to do (explicit drops)

From the Codex challenge + user decisions (2026-04-21):
- ❌ No admin panel (SSH + git + cron is ops)
- ❌ No queue display / "up next" (radio magic is surprise)
- ❌ No Camelot key / harmonic mixing (DJ-tool territory)
- ❌ No configurable-everything (5 crossfade curves, 8 visualizers, 3 themes, etc. — pick the best, ship)
- ❌ No SQLite in v3.0 (lands in v3.1 with full migration + backup story)
- ❌ No Discogs / Wikidata / TheAudioDB enrichment (Last.fm + MusicBrainz only, and not until v3.4)
- ❌ No `systemctl` / systemd in any form (use cron + nohup + watchdog)
- ❌ No public repo at launch (private; evaluate public + MIT once config abstraction is clean)

## 12. Where to find things

| Thing | Path |
|---|---|
| Stages config | `packages/shared/src/stages.ts` |
| Shared types | `packages/shared/src/types.ts` |
| Engine entry | `apps/engine/src/index.ts` |
| Web entry | `apps/web/src/index.ts` |
| Source-of-truth docs | `docs/*.md` |
| Whatbox Plex library | (on Whatbox) `/home/yolan/files/plex_music_library/opus/` |
| HLS output target | (on Whatbox) `/dev/shm/1008/radio-hls/<stage>/` |
| Deploy target | (on Whatbox) `~/webradio-v3/` (to be created) |

## 13. First action on a fresh session

1. Run `npm install` + `npm run typecheck`. Confirm scaffold compiles.
2. Read `docs/SLIM_V3.md` and `docs/WEEK0_LOG.md` in full (~15 min).
3. Propose the first implementation task in natural language — don't code yet.
4. Wait for user approval. Then implement exactly that one task.

---

## Review & Git workflow (non-negotiable)

### Branch discipline
- Never commit or push directly to `main` (or `master`). Ever.
- For any change: branch first. Naming: `feat/<slug>`, `fix/<slug>`,
  `chore/<slug>`, `refactor/<slug>`, `docs/<slug>`.
- If asked to make changes while on `main`, branch first, then work.

### Inner loop — between increments (fast, local)
After each logical increment (feature slice, bugfix, refactor):
1. `git add -A`
2. Run `/coderabbit:review uncommitted`
3. Address every Critical finding. Evaluate Suggestions on merit and apply
   the ones that improve the code.
4. Re-run `/coderabbit:review uncommitted` until no Critical remains.
5. Commit with a Conventional Commit message (`type(scope): subject`).
6. Move to the next increment.

Increment sizing: target under 300 LOC of diff per review cycle. If larger,
split it — do not try to review a 1000-line diff.

### Outer loop — PR & merge (formal gate)
When the full feature slice is done and all increments are committed:
1. `git push -u origin <branch>` (the pre-push hook will run CodeRabbit
   against `origin/main` first — if it fails, fix before retrying).
2. `gh pr create --draft --fill` — always draft, never ready-for-review
   on creation. Edit the body to explain the *why*, not just the *what*.
3. Wait for the CodeRabbit GitHub App review to post as PR comments. Poll
   with `gh pr view --comments` every 2–3 minutes. Do not spam.
4. Read ALL findings. Address Critical + relevant Suggestions. Push fixes
   as additional commits (never force-push during an active review —
   CodeRabbit does incremental reviews per push).
5. Repeat 3–4 until the PR review is clean.
6. `gh pr ready` to mark ready for human review.
7. Proceed to the **triple-signoff merge gate** below. Without that gate
   explicitly clean, I do not merge.

### Triple-signoff merge gate (when I may `gh pr merge`)
`gh pr merge` is **only** allowed when every single one of these is true:

1. **Claude** (me): I have re-read the full PR diff end-to-end and found
   no Critical / P1 / correctness / security issues. If I'm unsure,
   I'm not cleared — I stop and flag.
2. **Codex**: `/codex review` (the `/codex` gstack skill, Review mode,
   base = PR base branch) has been run and returns **GATE: PASS** with
   zero `[P1]` findings. A stale Codex run from an earlier commit does
   not count — the Codex review must cover the PR's current HEAD.
3. **CodeRabbit**: the CodeRabbit GitHub App review is in a clean state
   on the PR's current HEAD — no unresolved Critical / Potential-issue
   / Major findings. CodeRabbit's status check must be `SUCCESS`, and
   if a new commit has landed since the last CodeRabbit review, I
   trigger `@coderabbitai review` and wait for the incremental reply
   before claiming this bullet.
4. **Mechanics**: CI is green, the PR is out of draft (`gh pr ready`
   already run), and the PR base branch is up to date with `main`
   (rebase / retarget if stacked PRs have merged in the meantime).

When all four are true, merge with `gh pr merge <number> --squash` by
default (unless the PR explicitly calls for merge-commit or
rebase-merge in its description). Delete the branch on merge with
`--delete-branch` once it is no longer needed by a stacked dependent.

When **any** of the four is not true, the hard prohibition below
applies.

### Hard prohibitions
I will never:
- Push to `main` / `master` directly.
- `gh pr merge` unless the **Triple-signoff merge gate** above is
  entirely clean. Specifically: never `--auto`, never on a draft PR,
  never on an unreviewed commit, never on a stale Codex review.
- Force-push to a branch with an open PR under active CodeRabbit review.
- Use `--no-verify` to bypass the pre-push hook unless Yolan explicitly
  tells me to in this conversation.
- Skip `/coderabbit:review uncommitted` between increments to "save time".
- Open a non-draft PR. Always draft first, `gh pr ready` after clean.

### Fetching review feedback
- Local uncommitted: `/coderabbit:review uncommitted`
- Local committed (pre-push check): `coderabbit review --prompt-only --type committed --base origin/main`
- Open PR comments: `gh pr view [<number>] --comments`
- Full PR diff + review: `gh pr view <number> --json reviews,comments`

### Commit convention
Conventional Commits. Types: feat, fix, chore, refactor, docs, test, perf, ci.
Subject ≤ 72 chars. Body explains *why* when non-obvious. One logical change
per commit.
