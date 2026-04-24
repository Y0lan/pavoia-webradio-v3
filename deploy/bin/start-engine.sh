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
#   run/engine.lock           flock target (one start-engine.sh at a time)
#
# Engine env (Plex token, HLS_ROOT, etc.) lives in ~/.config/radio/env (Req G)
# and is sourced by this wrapper, not validated — apps/engine/src/config.ts
# does the validation and exits 1 on bad input, which the wrapper then catches
# via the post-spawn /api/health probe and reports as a startup failure.
#
# Exit-code contract (matters for deploy scripts and operator workflows):
#   0  — engine is running AND healthy (responds 2xx on /api/health), OR
#        another start-engine.sh holds the lock (idempotent no-op).
#   1  — failed to start a healthy engine (bad env, port bind failure, child
#        crash during bootstrap, /api/health didn't become responsive in time,
#        or an existing engine is wedged and we refuse to spawn over it).
#
# Cron @reboot can ignore the exit code; deploys and operators should not.

set -euo pipefail
umask 077

log() { printf '[start-engine] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
is_pid() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

RADIO_HOME="${RADIO_HOME:-$HOME/webradio-v3}"
ENV_FILE="${RADIO_ENV_FILE:-$HOME/.config/radio/env}"
# Wait budget for an in-flight engine to drain (graceful shutdown) before we
# treat it as wedged. Engine's SHUTDOWN_TIMEOUT_MS is 15 s
# (apps/engine/src/index.ts), so the default 20 s gives a small buffer.
DRAIN_WAIT_SECS="${ENGINE_DRAIN_WAIT_SECS:-20}"
# Wait budget for a freshly-spawned engine to start responding 2xx on
# /api/health. Real bootstrap is ~1–5 s on Whatbox; 15 s is generous.
HEALTH_WAIT_SECS="${ENGINE_HEALTH_WAIT_SECS:-15}"

NODE_BIN="$RADIO_HOME/bin/node"
ENGINE_ENTRY="$RADIO_HOME/apps/engine/dist/index.js"
LOG_DIR="$RADIO_HOME/logs"
RUN_DIR="$RADIO_HOME/run"
PID_FILE="$RUN_DIR/engine.pid"
LOG_FILE="$LOG_DIR/engine.log"
LOCK_FILE="$RUN_DIR/engine.lock"

[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (see WEEK0_LOG.md Req G)"
# Auto-export every assignment in the env file so PLEX_TOKEN, HLS_ROOT, etc.
# reach the engine child via the inherited environment. Operator may write
# `KEY=value` (no `export`) and it still propagates correctly.
set -a
# shellcheck disable=SC1090  # path resolved at runtime, not lintable here
. "$ENV_FILE"
set +a

# Validate the wait knobs before any arithmetic — a non-numeric value would
# crash the script under `set -e` mid-loop, leaving an unclear failure state.
case "$DRAIN_WAIT_SECS" in
  ''|*[!0-9]*) die "ENGINE_DRAIN_WAIT_SECS must be a non-negative integer, got '$DRAIN_WAIT_SECS'" ;;
esac
[ "$DRAIN_WAIT_SECS" -le 600 ] || die "ENGINE_DRAIN_WAIT_SECS too large (>600s), got $DRAIN_WAIT_SECS"
case "$HEALTH_WAIT_SECS" in
  ''|*[!0-9]*) die "ENGINE_HEALTH_WAIT_SECS must be a non-negative integer, got '$HEALTH_WAIT_SECS'" ;;
esac
[ "$HEALTH_WAIT_SECS" -le 600 ] || die "ENGINE_HEALTH_WAIT_SECS too large (>600s), got $HEALTH_WAIT_SECS"

[ -x "$NODE_BIN" ] || die "node binary missing or not executable: $NODE_BIN (deploy must symlink mise Node 22.22.2 here, Req I)"
[ -f "$ENGINE_ENTRY" ] || die "engine build artifact missing: $ENGINE_ENTRY (run 'npm run build' before starting)"
command -v curl >/dev/null 2>&1 || die "curl not found on PATH (required for /api/health probes)"

mkdir -p "$LOG_DIR" "$RUN_DIR"

# Hold a non-blocking exclusive lock for the wrapper's lifetime. Two
# concurrent start-engine.sh invocations no longer both spawn — the loser
# exits 0 idempotently because the winner is doing the work. fd 9 is
# explicitly closed in the engine child (`9>&-` on the nohup line below),
# so the lock releases as soon as this wrapper exits, even though the
# engine is still alive. That keeps the real lock semantics tight on
# "wrapper in flight" instead of accidentally widening to "engine alive."
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another start-engine.sh holds the lock ($LOCK_FILE); nothing to do"
  exit 0
fi

ENGINE_PORT="${ENGINE_PORT:-3001}"
HEALTH_URL="http://127.0.0.1:${ENGINE_PORT}/api/health"

# Returns 0 iff /api/health responds with a 2xx within 2 s. curl writes the
# HTTP code to stdout; on connection refused / timeout it writes "000" so we
# never need to interpret curl's exit code separately.
probe_health() {
  local code
  code="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$HEALTH_URL" 2>/dev/null || echo 000)"
  case "$code" in
    2*) return 0 ;;
    *)  return 1 ;;
  esac
}

if [ -f "$PID_FILE" ]; then
  existing_pid="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
  if ! is_pid "$existing_pid"; then
    log "invalid pid file content ('$existing_pid'); clearing"
    rm -f "$PID_FILE"
  elif ! kill -0 "$existing_pid" 2>/dev/null; then
    log "stale pid file (pid $existing_pid not alive); clearing"
    rm -f "$PID_FILE"
  else
    # Defend against post-reboot PID reuse — if some unrelated process
    # happens to hold the recorded PID number, it's not ours and the file
    # is stale. UID match is good enough for a $HOME-stored pidfile under
    # the engine's threat model.
    pid_uid="$(ps -o uid= -p "$existing_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    our_uid="$(id -u)"
    if [ -z "$pid_uid" ] || [ "$pid_uid" != "$our_uid" ]; then
      log "pid $existing_pid alive but not owned by us (uid=${pid_uid:-?} vs ${our_uid}); treating as stale"
      rm -f "$PID_FILE"
    elif probe_health; then
      log "engine pid $existing_pid responds healthy on /api/health; nothing to do"
      exit 0
    else
      # Alive, ours, but not responding. Two situations collapse here:
      #   (a) Engine in graceful-shutdown drain — deploy/watchdog flow is
      #       `kill && start-engine.sh` per WEEK0_LOG.md Step 2 / Req J.
      #       Engine's SHUTDOWN_TIMEOUT_MS is 15 s. Wait it out, then spawn.
      #   (b) Engine wedged — bootstrap stalled, Plex hang holding the event
      #       loop, etc. start-engine.sh is not the health authority; if a
      #       wedged engine is still alive after the drain wait, refuse to
      #       spawn over it (would orphan the wedged child) and exit 1 so
      #       the operator/watchdog escalates.
      log "engine pid $existing_pid alive but unresponsive on /api/health; waiting up to ${DRAIN_WAIT_SECS}s for drain"
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
        die "engine pid $existing_pid alive and unresponsive after ${DRAIN_WAIT_SECS}s — wedged; refusing to spawn over it (kill it first, then retry)"
      fi
    fi
  fi
fi

log "spawning engine: $NODE_BIN $ENGINE_ENTRY"
# 9>&- explicitly closes the flock fd in the child so the lock releases
# when this wrapper exits, not when the engine exits (see the exec 9> block).
nohup "$NODE_BIN" "$ENGINE_ENTRY" >>"$LOG_FILE" 2>&1 9>&- &
engine_pid=$!
disown "$engine_pid" 2>/dev/null || true
# Write the pidfile immediately so operators / watchdog can see the child
# during its bootstrap window. If health verification fails below we'll
# clean it up.
echo "$engine_pid" >"$PID_FILE"
log "spawned engine pid $engine_pid; verifying /api/health (up to ${HEALTH_WAIT_SECS}s)"

healthy="no"
deadline_tenths=$((HEALTH_WAIT_SECS * 2))
tenths=0
while [ "$tenths" -lt "$deadline_tenths" ]; do
  if ! kill -0 "$engine_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    die "engine pid $engine_pid exited during startup — check $LOG_FILE"
  fi
  if probe_health; then
    healthy="yes"
    break
  fi
  sleep 0.5
  tenths=$((tenths + 1))
done

if [ "$healthy" != "yes" ]; then
  log "engine pid $engine_pid did not become healthy within ${HEALTH_WAIT_SECS}s; killing"
  kill -TERM "$engine_pid" 2>/dev/null || true
  sleep 1
  kill -KILL "$engine_pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  die "engine failed to come up healthy in ${HEALTH_WAIT_SECS}s — check $LOG_FILE"
fi

log "engine healthy in $((tenths / 2))s (pid $engine_pid); logs: $LOG_FILE"
