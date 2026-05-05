# Pavoia Webradio v3 — deploy

Operator runbook for running the v3 engine on Whatbox. No systemd, no process
manager — just `cron + nohup + watchdog`, the pattern v1/v2 already use
(verified 2026-04-21, see `docs/WEEK0_LOG.md` Step 2).

## Layout on Whatbox

```text
~/webradio-v3/
├── apps/engine/dist/
│   └── index.js              # built engine entry (npm run build)
├── assets/
│   └── curating.aac          # silence loop for empty playlists
├── bin/
│   ├── node                  # symlink → mise-managed Node 22.22.2
│   ├── start-engine.sh       # symlink → ../deploy/bin/start-engine.sh
│   └── watchdog.sh           # symlink → ../deploy/bin/watchdog.sh
├── deploy/                   # checked-in scripts + this README
├── logs/
│   ├── engine.log            # engine stdout + stderr (append-only)
│   └── cron.log              # @reboot + watchdog cron output
└── run/
    ├── engine.pid            # current engine PID
    ├── engine.lock           # start-engine.sh single-instance lock
    ├── watchdog.lock         # watchdog.sh single-instance lock
    └── watchdog.state        # consecutive-HTTP-000 counter

~/.config/radio/env           # Plex token + every tunable. Mode 0600.
                              # Lives outside webradio-v3/ so deploys
                              # (rsync) don't overwrite it.
```

## First-time install

All commands below run on Whatbox (`ssh whatbox`).

### 1. Pin Node 22.22.2 via mise

```bash
mise install node@22.22.2
mkdir -p ~/webradio-v3/bin
ln -sfn ~/.local/share/mise/installs/node/22.22.2/bin/node ~/webradio-v3/bin/node
~/webradio-v3/bin/node --version   # → v22.22.2
```

### 2. Rsync the repo + build the engine

From your dev machine:

```bash
rsync -av --exclude .git --exclude node_modules --exclude dist \
      --exclude 'tsconfig.tsbuildinfo' \
      ./ whatbox:~/webradio-v3/
ssh whatbox 'cd ~/webradio-v3 && npm ci && npm run build --workspace=@pavoia/engine'
```

Verify `~/webradio-v3/apps/engine/dist/index.js` exists.

### 3. Symlink the wrapper scripts into bin/

```bash
ssh whatbox 'cd ~/webradio-v3/bin && \
  ln -sf ../deploy/bin/start-engine.sh && \
  ln -sf ../deploy/bin/watchdog.sh'
```

### 4. Create the env file

```bash
mkdir -p ~/.config/radio && chmod 700 ~/.config/radio
cp ~/webradio-v3/deploy/env.example ~/.config/radio/env
chmod 600 ~/.config/radio/env
$EDITOR ~/.config/radio/env   # paste the real PLEX_TOKEN, etc.
```

### 5. Stage the curating fallback

```bash
mkdir -p ~/webradio-v3/assets
ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 10 \
       -c:a aac -b:a 128k ~/webradio-v3/assets/curating.aac
```

### 6. First start (manually, to surface errors immediately)

```bash
~/webradio-v3/bin/start-engine.sh
# Expected last line: "engine healthy in Ns (pid NNNNN); logs: ~/webradio-v3/logs/engine.log"
curl -s http://127.0.0.1:3001/api/health | head -c 200
```

If anything fails the wrapper exits non-zero with a clear `[start-engine] ERROR: ...` line; check `~/webradio-v3/logs/engine.log` for the engine's own complaint.

### 7. Install the crontab

```bash
crontab -l > /tmp/cron.bak                                       # backup
cat /tmp/cron.bak ~/webradio-v3/deploy/crontab.example | crontab -
crontab -l | grep webradio-v3                                    # verify
```

## Ongoing deploys

```bash
# 1. Push code
rsync -av --exclude .git --exclude node_modules --exclude dist \
      --exclude 'tsconfig.tsbuildinfo' \
      ./ whatbox:~/webradio-v3/

# 2. Build
ssh whatbox 'cd ~/webradio-v3 && npm ci && npm run build --workspace=@pavoia/engine'

# 3. Restart (the wrapper handles drain race + post-spawn health verify)
ssh whatbox '
  if [ -f ~/webradio-v3/run/engine.pid ]; then
    kill $(cat ~/webradio-v3/run/engine.pid) 2>/dev/null || true
  fi
  ~/webradio-v3/bin/start-engine.sh
'
```

`start-engine.sh` exits 0 only if `/api/health` is responsive; the SSH session inherits its non-zero exit so a failed deploy is visible.

## Stopping the engine

```bash
crontab -l | grep -v webradio-v3 | crontab -                # remove cron entries
kill $(cat ~/webradio-v3/run/engine.pid) 2>/dev/null || true
```

The `crontab -l | grep -v ...` step is critical — otherwise the watchdog will respawn the engine within 3 minutes.

## Troubleshooting

**Engine won't start.** Check `~/webradio-v3/logs/engine.log`. Most failures are missing/wrong env vars; `apps/engine/src/config.ts` collects every error in one pass and exits 1 with the full punch list.

**Engine alive but unresponsive.** `start-engine.sh` will refuse to spawn over a wedged engine (exits 1 "wedged"). Force kill: `kill -KILL $(cat ~/webradio-v3/run/engine.pid)`. Next watchdog tick (within 60s) respawns fresh.

**Watchdog seems stuck.** Tail `~/webradio-v3/logs/cron.log` — every probe + decision lands there. If you see `cmdline does not include`, the recorded PID isn't our engine (it's been recycled). Manually clear: `rm ~/webradio-v3/run/engine.pid` and let the next watchdog tick spawn fresh.

**Watchdog never triggers a restart.** Reset its state: `rm ~/webradio-v3/run/watchdog.state`. Next probe starts the consecutive-failure counter from zero.

**Need to override a tunable temporarily.** Edit `~/.config/radio/env` and either restart manually (`kill $(cat run/engine.pid) && bin/start-engine.sh`) or wait for the next watchdog cycle. Both wrappers re-source the env file on every invocation.

## Reference

- `deploy/env.example` — every env var documented with default and source script.
- `deploy/crontab.example` — annotated cron entries.
- `apps/engine/README.md` — engine HTTP contract, exit codes, log format.
- `docs/WEEK0_LOG.md` — the 16 locked deploy requirements (A–P) this all derives from.
