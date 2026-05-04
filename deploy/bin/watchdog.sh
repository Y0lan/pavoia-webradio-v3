#!/usr/bin/env bash
# watchdog.sh — Whatbox cron-minute watchdog for the Pavoia v3 audio engine.
#
# Invoked from cron `* * * * *`. Probes /api/health once and decides:
#   200 (or any 2xx)  → engine healthy, reset failure counter, exit 0.
#   5xx               → engine alive-but-degraded (Req J: must NOT trigger
#                       restart, restart would destroy diagnostic state),
#                       reset counter, exit 0.
#   000 (refused/timeout) → increment counter.
#       <THRESHOLD consecutive  → log + exit 0.
#       =THRESHOLD consecutive  → reset counter, restart sequence:
#         1. Read engine.pid; verify it points at OUR engine via cmdline
#            (defends against PID-recycle to an unrelated same-user proc).
#         2. SIGTERM the engine; wait up to TERM_WAIT_SECS for exit.
#         3. If still alive, escalate to SIGKILL; wait KILL_WAIT_SECS more.
#         4. Invoke start-engine.sh. Its own preconditions + health probe
#            decide whether the new spawn is healthy; we just propagate
#            its exit code.
#
# State file: $RUN_DIR/watchdog.state — single integer line, the current
# consecutive-000 count. Persists across cron re-execs (Req J) and is
# atomically rewritten via temp + mv.
#
# Lock: $RUN_DIR/watchdog.lock — non-blocking flock, prevents two
# overlapping cron invocations during long restart sequences.
#
# Exit codes:
#   0 — probe handled successfully (any decision).
#   1 — preconditions failed, lock error, or restart sequence couldn't
#       complete (engine still alive after SIGKILL, start-engine.sh failed).

set -euo pipefail
umask 077

log() { printf '[watchdog] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
is_pid() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
pid_cmdline() {
  cat "/proc/$1/cmdline" 2>/dev/null | tr '\0' ' ' || true
}
# Returns 0 iff the cmdline string represents OUR engine: argv[0] basenames
# to "node" AND $ENGINE_ENTRY appears as a complete argv token. The previous
# substring match (`*" $entry "*`) false-positived on commands like
# `vim apps/engine/dist/index.js` where the path is just an argument to a
# non-node program. [#15 item 6]
is_our_engine() {
  local cmdline="$1" entry="$2"
  # shellcheck disable=SC2206  # we want word-splitting on the cmdline
  local argv=( $cmdline )
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

START_ENGINE_SH="$RADIO_HOME/bin/start-engine.sh"
ENGINE_ENTRY="$RADIO_HOME/apps/engine/dist/index.js"
RUN_DIR="$RADIO_HOME/run"
PID_FILE="$RUN_DIR/engine.pid"
STATE_FILE="$RUN_DIR/watchdog.state"
LOCK_FILE="$RUN_DIR/watchdog.lock"

[ -f "$ENV_FILE" ] || die "env file not found: $ENV_FILE (see WEEK0_LOG.md Req G)"
set -a
# shellcheck disable=SC1090  # path resolved at runtime, not lintable here
. "$ENV_FILE"
set +a

# Read all knobs AFTER env source so operator overrides in $ENV_FILE win.
THRESHOLD="${WATCHDOG_FAILURE_THRESHOLD:-3}"
TERM_WAIT_SECS="${WATCHDOG_TERM_WAIT_SECS:-15}"
KILL_WAIT_SECS="${WATCHDOG_KILL_WAIT_SECS:-5}"
ENGINE_PORT="${ENGINE_PORT:-3001}"

# Validate every knob before any arithmetic — non-numeric values would
# crash the script under `set -e` and cron would silently log the failure.
case "$THRESHOLD" in
  ''|*[!0-9]*) die "WATCHDOG_FAILURE_THRESHOLD must be a positive integer, got '$THRESHOLD'" ;;
esac
[ "$THRESHOLD" -ge 1 ] && [ "$THRESHOLD" -le 100 ] || die "WATCHDOG_FAILURE_THRESHOLD out of range [1..100], got $THRESHOLD"
case "$TERM_WAIT_SECS" in
  ''|*[!0-9]*) die "WATCHDOG_TERM_WAIT_SECS must be a non-negative integer, got '$TERM_WAIT_SECS'" ;;
esac
[ "$TERM_WAIT_SECS" -le 600 ] || die "WATCHDOG_TERM_WAIT_SECS too large (>600s), got $TERM_WAIT_SECS"
case "$KILL_WAIT_SECS" in
  ''|*[!0-9]*) die "WATCHDOG_KILL_WAIT_SECS must be a non-negative integer, got '$KILL_WAIT_SECS'" ;;
esac
[ "$KILL_WAIT_SECS" -le 600 ] || die "WATCHDOG_KILL_WAIT_SECS too large (>600s), got $KILL_WAIT_SECS"
case "$ENGINE_PORT" in
  ''|*[!0-9]*) die "ENGINE_PORT must be a positive integer, got '$ENGINE_PORT'" ;;
esac
[ "$ENGINE_PORT" -ge 1 ] && [ "$ENGINE_PORT" -le 65535 ] || die "ENGINE_PORT out of range [1..65535], got $ENGINE_PORT"

[ -x "$START_ENGINE_SH" ] || die "start-engine.sh not found or not executable: $START_ENGINE_SH"
command -v curl  >/dev/null 2>&1 || die "curl not found on PATH (required for /api/health probe)"
command -v flock >/dev/null 2>&1 || die "flock not found on PATH (required for concurrency lock)"
command -v ps    >/dev/null 2>&1 || die "ps not found on PATH (required for PID identity check)"

mkdir -p "$RUN_DIR"

# Lock — distinguish lock contention (exit 1 from flock) from any other
# flock failure. Without this, a missing/broken flock would silently no-op
# and cron would think the watchdog ran successfully.
exec 9>"$LOCK_FILE"
if flock -n 9; then
  : # acquired
else
  rc=$?
  case "$rc" in
    1) log "another watchdog invocation in flight (lock $LOCK_FILE); exiting 0"; exit 0 ;;
    *) die "flock failed unexpectedly (exit=$rc)" ;;
  esac
fi

HEALTH_URL="http://127.0.0.1:${ENGINE_PORT}/api/health"

# curl writes the HTTP code to stdout via --write-out (including "000" on
# connection refused / timeout). `|| true` keeps set -e from killing us on
# curl's non-zero exit; the ${code:-000} default covers the unlikely case
# where curl wrote literally nothing.
# Don't append `|| echo 000` to the curl pipe — curl ALREADY prints "000"
# in the failure case, and a fallback would concatenate to "000000" which
# would miss the `000)` case below.
http_code() {
  local code
  code="$(curl --silent --max-time 2 --output /dev/null --write-out '%{http_code}' "$HEALTH_URL" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

write_state() {
  local n="$1"
  printf '%s\n' "$n" >"$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# Read consecutive-000 counter from state file. Treat missing or malformed
# values as 0 (no prior failures recorded).
count=0
if [ -f "$STATE_FILE" ]; then
  raw="$(tr -d '[:space:]' <"$STATE_FILE" 2>/dev/null || true)"
  case "$raw" in
    ''|*[!0-9]*) log "invalid state file content ('$raw'); resetting to 0" ;;
    *)           count="$raw" ;;
  esac
fi

code="$(http_code)"
log "probe: HTTP $code  (consecutive_000=$count, threshold=$THRESHOLD)"

case "$code" in
  2*)
    if [ "$count" -gt 0 ]; then log "engine recovered from $count consecutive failure(s)"; fi
    write_state 0
    exit 0
    ;;
  5*)
    # Per Req J: 5xx is alive-but-degraded; restart would destroy state.
    if [ "$count" -gt 0 ]; then log "engine returned 5xx (alive-but-degraded); resetting counter"; fi
    write_state 0
    exit 0
    ;;
  000)
    count=$((count + 1))
    if [ "$count" -lt "$THRESHOLD" ]; then
      log "HTTP 000 — count now $count/$THRESHOLD"
      write_state "$count"
      exit 0
    fi
    log "HTTP 000 reached threshold ($count/$THRESHOLD) — restarting engine"
    # Reset counter BEFORE the restart so a failed restart attempt doesn't
    # immediately re-trigger restart on the next tick — the next tick gets
    # a fresh 0 → 1 → 2 → 3 cycle, giving the operator 3 minutes to
    # intervene before the next attempt.
    write_state 0
    ;;
  *)
    log "unexpected HTTP code: $code; treating as alive-but-degraded (no restart)"
    write_state 0
    exit 0
    ;;
esac

# --- Restart sequence ---

existing_pid=""
if [ -f "$PID_FILE" ]; then
  raw="$(tr -d '[:space:]' <"$PID_FILE" 2>/dev/null || true)"
  if is_pid "$raw"; then existing_pid="$raw"; fi
fi

wait_pid_exit() {
  local pid="$1" budget="$2"
  local deadline=$(($(date +%s) + budget))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -0 "$pid" 2>/dev/null && return 1 || return 0
}

if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
  cmdline="$(pid_cmdline "$existing_pid")"
  if is_our_engine "$cmdline" "$ENGINE_ENTRY"; then
    log "sending SIGTERM to engine pid $existing_pid"
    kill -TERM "$existing_pid" 2>/dev/null || true
    if wait_pid_exit "$existing_pid" "$TERM_WAIT_SECS"; then
      log "engine pid $existing_pid exited cleanly"
    else
      log "engine pid $existing_pid did not exit within ${TERM_WAIT_SECS}s — escalating to SIGKILL"
      # Re-check cmdline before SIGKILL — if the PID was recycled to
      # something else during our wait, don't kill the unrelated process.
      cmdline_now="$(pid_cmdline "$existing_pid")"
      if is_our_engine "$cmdline_now" "$ENGINE_ENTRY"; then
        kill -KILL "$existing_pid" 2>/dev/null || true
        if ! wait_pid_exit "$existing_pid" "$KILL_WAIT_SECS"; then
          die "engine pid $existing_pid still alive after SIGKILL; aborting restart (next tick will retry)"
        fi
        log "engine pid $existing_pid killed"
      else
        log "pid $existing_pid no longer matches our engine cmdline; skipping SIGKILL"
      fi
    fi
  else
    log "pid $existing_pid alive but cmdline doesn't match our engine (argv[0] != node OR $ENGINE_ENTRY not an argv token); not killing (start-engine.sh will sort it out)"
  fi
fi

log "invoking $START_ENGINE_SH"
if "$START_ENGINE_SH"; then
  log "engine restart succeeded"
  exit 0
else
  rc=$?
  die "start-engine.sh failed (exit=$rc); next watchdog tick will retry"
fi
