#!/usr/bin/env bash
# start-engine.sh — Whatbox launcher for the Pavoia v3 audio engine.
#
# Invoked from cron @reboot (initial start) and from watchdog.sh (respawn after
# 3 consecutive HTTP 000 — see WEEK0_LOG.md Req J). Idempotent: a second
# invocation while the engine is already healthy exits 0 without action.
#
# Layout assumed under $RADIO_HOME (default ~/webradio-v3):
#   bin/node                  symlink to mise-managed Node 22.22.2 (Req I)
#   apps/engine/dist/index.js compiled engine entry point (npm run build)
#   logs/engine.log           append-only stdout+stderr (Req H)
#   run/engine.pid            current engine PID (consumed by watchdog.sh)
#
# Engine env (Plex token, HLS_ROOT, etc.) lives in ~/.config/radio/env (Req G)
# and is sourced by this wrapper, not validated — apps/engine/src/config.ts
# does the validation and exits 1 on bad input, which the watchdog detects as
# HTTP 000 and respawns from.

set -euo pipefail
umask 077

log() { printf '[start-engine] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

RADIO_HOME="${RADIO_HOME:-$HOME/webradio-v3}"
ENV_FILE="${RADIO_ENV_FILE:-$HOME/.config/radio/env}"
# Wait budget for an in-flight engine to drain before we declare it healthy.
# The engine has a 15 s graceful-shutdown budget (apps/engine/README.md), so we
# need a strictly larger window. Override via env for fast smoke tests.
DRAIN_WAIT_SECS="${ENGINE_DRAIN_WAIT_SECS:-20}"

NODE_BIN="$RADIO_HOME/bin/node"
ENGINE_ENTRY="$RADIO_HOME/apps/engine/dist/index.js"
LOG_DIR="$RADIO_HOME/logs"
RUN_DIR="$RADIO_HOME/run"
PID_FILE="$RUN_DIR/engine.pid"
LOG_FILE="$LOG_DIR/engine.log"

[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (see WEEK0_LOG.md Req G)"
# Auto-export every assignment in the env file so PLEX_TOKEN, HLS_ROOT, etc.
# reach the engine child via the inherited environment. Operator may write
# `KEY=value` (no `export`) and it still propagates correctly.
set -a
# shellcheck disable=SC1090  # path resolved at runtime, not lintable here
. "$ENV_FILE"
set +a

[ -x "$NODE_BIN" ] || die "node binary missing or not executable: $NODE_BIN (deploy must symlink mise Node 22.22.2 here, Req I)"
[ -f "$ENGINE_ENTRY" ] || die "engine build artifact missing: $ENGINE_ENTRY (run 'npm run build' before starting)"

mkdir -p "$LOG_DIR" "$RUN_DIR"

if [ -f "$PID_FILE" ]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "$existing_pid" ]; then
    log "empty pid file; clearing"
    rm -f "$PID_FILE"
  elif ! kill -0 "$existing_pid" 2>/dev/null; then
    log "stale pid file (pid $existing_pid not alive); clearing"
    rm -f "$PID_FILE"
  else
    # PID is alive. Confirm it's owned by us — defends against post-reboot PID
    # reuse where the recorded number now belongs to some unrelated process.
    pid_uid="$(ps -o uid= -p "$existing_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    our_uid="$(id -u)"
    if [ -z "$pid_uid" ] || [ "$pid_uid" != "$our_uid" ]; then
      log "pid $existing_pid alive but not owned by us (uid=${pid_uid:-?} vs ${our_uid}); treating as stale"
      rm -f "$PID_FILE"
    else
      # Genuinely an alive process we own. Two cases collapse here:
      #   (a) Healthy engine called via @reboot or watchdog-against-healthy.
      #       Should leave it alone.
      #   (b) Engine in graceful-shutdown drain — deploy/watchdog flow is
      #       `kill && start-engine.sh` per WEEK0_LOG.md Step 2, and the
      #       engine takes up to 15 s to flush in-flight requests.
      #       Without waiting we'd false-positive (b) as (a), see the old
      #       engine exit moments later, and leave nothing running until
      #       the next watchdog tick (≥3 minutes of dead air). [Codex P1]
      # Wait up to DRAIN_WAIT_SECS for it to exit, polling every 0.5 s.
      log "found alive engine pid $existing_pid; waiting up to ${DRAIN_WAIT_SECS}s for drain"
      drained="no"
      deadline_tenths=$((DRAIN_WAIT_SECS * 2))
      tenths=0
      while [ "$tenths" -lt "$deadline_tenths" ]; do
        if ! kill -0 "$existing_pid" 2>/dev/null; then
          drained="yes"
          break
        fi
        sleep 0.5
        tenths=$((tenths + 1))
      done
      if [ "$drained" = "yes" ]; then
        log "previous engine pid $existing_pid drained after $((tenths / 2))s; spawning fresh"
        rm -f "$PID_FILE"
      else
        log "engine still healthy after ${DRAIN_WAIT_SECS}s wait (pid $existing_pid); nothing to do"
        exit 0
      fi
    fi
  fi
fi

log "spawning engine: $NODE_BIN $ENGINE_ENTRY"
nohup "$NODE_BIN" "$ENGINE_ENTRY" >>"$LOG_FILE" 2>&1 &
engine_pid=$!
disown "$engine_pid" 2>/dev/null || true
echo "$engine_pid" >"$PID_FILE"
log "engine started (pid $engine_pid); logs: $LOG_FILE"
