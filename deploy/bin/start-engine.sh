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
# Read /proc/$pid/cmdline as a space-joined string. Returns empty if the
# pid no longer exists or proc isn't available.
# Returns 0 iff /proc/<pid>/cmdline represents OUR engine: argv[0] basenames
# to "node" AND $entry appears as a complete argv token.
#
# Reads /proc directly with NUL-aware splitting via `mapfile -d ''` so that
# argv tokens containing whitespace are preserved — the previous version
# converted NUL→space and word-split, which broke for ENGINE_ENTRY paths
# under a RADIO_HOME containing whitespace (e.g. '/srv/pavoia radio').
# [#15 item 6, Codex round-1 P2 on PR #18]
#
# Original substring match was insufficient: `*" $entry "*` matched
# `vim apps/engine/dist/index.js` because the path appeared as an argv to
# a non-node program. The argv[0]=node + entry-as-token check fixes that.
is_our_engine() {
  local pid="$1" entry="$2"
  local -a argv
  # mapfile -d '' splits on NUL (bash 4.4+, available on all modern Linux).
  # 2>/dev/null + || return 1 covers the TOCTOU window where the pid exits
  # between the caller's kill -0 check and our open here.
  mapfile -d '' argv < "/proc/$pid/cmdline" 2>/dev/null || return 1
  [ "${#argv[@]}" -ge 2 ] || return 1
  [ "${argv[0]##*/}" = "node" ] || return 1
  local i
  for ((i=1; i<${#argv[@]}; i++)); do
    [ "${argv[i]}" = "$entry" ] && return 0
  done
  return 1
}

RADIO_HOME="${RADIO_HOME:-$HOME/webradio-v3}"
ENV_FILE="${RADIO_ENV_FILE:-$HOME/.config/radio/env}"

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

# Read wait-knob env vars AFTER sourcing the env file — the operator's
# overrides in $ENV_FILE need to take effect, not the bash environment at
# script-start time. [#15 item 1]
# Wait budget for an in-flight engine to drain (graceful shutdown) before
# we treat it as wedged. Engine's SHUTDOWN_TIMEOUT_MS is 15 s
# (apps/engine/src/index.ts), so the default 20 s gives a small buffer.
DRAIN_WAIT_SECS="${ENGINE_DRAIN_WAIT_SECS:-20}"
# Wait budget for a freshly-spawned engine to start responding 2xx on
# /api/health. Real bootstrap is ~1–5 s on Whatbox; 15 s is generous.
HEALTH_WAIT_SECS="${ENGINE_HEALTH_WAIT_SECS:-15}"

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
command -v ss >/dev/null 2>&1 || die "ss not found on PATH (required for orphan-listener pre-spawn check)"
command -v ps >/dev/null 2>&1 || die "ps not found on PATH (required for PID ownership/identity checks)"

mkdir -p "$LOG_DIR" "$RUN_DIR"

# Hold a non-blocking exclusive lock for the wrapper's lifetime. Two
# concurrent start-engine.sh invocations no longer both spawn — the loser
# exits 0 idempotently because the winner is doing the work. fd 9 is
# explicitly closed in the engine child (`9>&-` on the nohup line below),
# so the lock releases as soon as this wrapper exits, even though the
# engine is still alive. That keeps the real lock semantics tight on
# "wrapper in flight" instead of accidentally widening to "engine alive."
exec 9>"$LOCK_FILE"
# Distinguish lock contention (flock exit 1, idempotent no-op) from any
# other flock failure (kernel rejected, fd issues — die loudly so cron
# doesn't silently report success on a wrapper that did nothing). [#15 item 2]
if flock -n 9; then
  : # acquired
else
  rc=$?
  case "$rc" in
    1) log "another start-engine.sh holds the lock ($LOCK_FILE); nothing to do"; exit 0 ;;
    *) die "flock failed unexpectedly (exit=$rc)" ;;
  esac
fi

ENGINE_PORT="${ENGINE_PORT:-3001}"
# Validate ENGINE_PORT before constructing the health URL or ss filter — a
# non-numeric or out-of-range value would otherwise produce cryptic curl/ss
# errors. The engine's own loadConfig validates again at boot, but failing
# here gives the operator the same clear punch-list error format. [#15 item 5]
case "$ENGINE_PORT" in
  ''|*[!0-9]*) die "ENGINE_PORT must be a positive integer, got '$ENGINE_PORT'" ;;
esac
[ "$ENGINE_PORT" -ge 1 ] && [ "$ENGINE_PORT" -le 65535 ] || die "ENGINE_PORT out of range [1..65535], got $ENGINE_PORT"
HEALTH_URL="http://127.0.0.1:${ENGINE_PORT}/api/health"

# Returns 0 iff /api/health responds with a 2xx within 2 s. curl writes the
# HTTP code via --write-out (including "000" on connection refused/timeout).
# `|| true` keeps set -e from killing us on curl's non-zero exit. The fallback
# is via parameter default, NOT `|| echo 000` after the pipe — that form
# concatenates curl's "000" with the echo's "000" producing "000000".
probe_health() {
  local code
  code="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  case "${code:-000}" in
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
    # Defend against post-reboot PID reuse and same-user node confusion.
    # Two-pronged check:
    #   1. UID match (cheap rule-out for cross-user reuse).
    #   2. /proc/$pid/cmdline includes our exact ENGINE_ENTRY path. Just
    #      checking comm=node was ambiguous on a host running multiple
    #      same-user node processes (e.g. apps/web alongside the engine);
    #      the cmdline check pins the recorded PID specifically to our
    #      engine entry point. [Codex round-4 P2-A]
    # Without these, a stale PID held by an unrelated process would force
    # the wrapper through the full drain wait then exit 1 "wedged," looping
    # every watchdog tick until manual cleanup. [Codex round-3 P2]
    pid_uid="$(ps -o uid= -p "$existing_pid" 2>/dev/null | tr -d '[:space:]' || true)"
    our_uid="$(id -u)"
    if [ -z "$pid_uid" ] || [ "$pid_uid" != "$our_uid" ]; then
      log "pid $existing_pid alive but not owned by us (uid=${pid_uid:-?} vs ${our_uid}); treating as stale"
      rm -f "$PID_FILE"
    elif ! is_our_engine "$existing_pid" "$ENGINE_ENTRY"; then
      log "pid $existing_pid alive but cmdline doesn't match our engine (argv[0] != node OR $ENGINE_ENTRY not an argv token); treating as stale"
      rm -f "$PID_FILE"
    elif probe_health && { sleep 0.25; probe_health; }; then
      # Two probes 250 ms apart confirm the engine isn't just a few
      # milliseconds away from processing an in-flight SIGTERM. The
      # documented deploy/watchdog flow is `kill && start-engine.sh`,
      # and Node's signal handler can take 1–100 ms to run before
      # server.close() actually stops accepting connections — a single
      # probe in that window false-positives "healthy" then the engine
      # dies behind us. [Codex round-4 P2-B]
      log "engine pid $existing_pid responds healthy on /api/health (confirmed); nothing to do"
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
      drain_start=$(date +%s)
      drain_deadline=$((drain_start + DRAIN_WAIT_SECS))
      drained="no"
      while [ "$(date +%s)" -lt "$drain_deadline" ]; do
        if ! kill -0 "$existing_pid" 2>/dev/null; then
          drained="yes"
          break
        fi
        sleep 0.5
      done
      drain_elapsed=$(($(date +%s) - drain_start))
      if [ "$drained" = "yes" ]; then
        log "previous engine pid $existing_pid drained after ${drain_elapsed}s; spawning fresh"
        rm -f "$PID_FILE"
      else
        die "engine pid $existing_pid alive and unresponsive after ${drain_elapsed}s — wedged; refusing to spawn over it (kill it first, then retry)"
      fi
    fi
  fi
fi

# Refuse to spawn if anything is already bound to ENGINE_PORT — orphans from
# a prior crashed wrapper or operator-spawned engines would otherwise let our
# new child fail EADDRINUSE while probe_health hits the orphan and returns
# 200, falsely marking startup successful with a dead-PID pointer.
# [Codex round-3 P2]
# `ss -ltnH "sport = :PORT"` filters by source port directly — robust against
# ss column-ordering variations across versions; -H suppresses the header.
if [ -n "$(ss -ltnH "sport = :${ENGINE_PORT}" 2>/dev/null)" ]; then
  die "another process is already bound to port ${ENGINE_PORT} (orphan engine?); refusing to spawn — kill it first"
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

# Wall-clock deadline (not iteration counting) — each probe_health can block
# up to curl --max-time 2, so an iteration counter would understate elapsed
# time by up to 5x. Wall-clock makes the budget honest. [Codex round-3 P3]
health_start=$(date +%s)
health_deadline=$((health_start + HEALTH_WAIT_SECS))
healthy="no"
while [ "$(date +%s)" -lt "$health_deadline" ]; do
  if ! kill -0 "$engine_pid" 2>/dev/null; then
    rm -f "$PID_FILE"
    die "engine pid $engine_pid exited during startup — check $LOG_FILE"
  fi
  if probe_health; then
    healthy="yes"
    break
  fi
  sleep 0.5
done
health_elapsed=$(($(date +%s) - health_start))

if [ "$healthy" != "yes" ]; then
  log "engine pid $engine_pid did not become healthy within ${health_elapsed}s; killing"
  kill -TERM "$engine_pid" 2>/dev/null || true
  sleep 1
  # Re-check identity before SIGKILL — if PID was recycled to an unrelated
  # same-user process during the SIGTERM grace window, don't kill it.
  # [#15 item 4]
  if kill -0 "$engine_pid" 2>/dev/null; then
    if is_our_engine "$engine_pid" "$ENGINE_ENTRY"; then
      kill -KILL "$engine_pid" 2>/dev/null || true
    else
      log "pid $engine_pid no longer matches our engine cmdline; skipping SIGKILL"
    fi
  fi
  rm -f "$PID_FILE"
  die "engine failed to come up healthy in ${health_elapsed}s — check $LOG_FILE"
fi

log "engine healthy in ${health_elapsed}s (pid $engine_pid); logs: $LOG_FILE"
