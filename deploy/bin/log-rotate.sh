#!/usr/bin/env bash
# deploy/bin/log-rotate.sh — size-capped, copytruncate log rotation.
#
# Closes one of the four follow-ups in #19 (log-rotation hygiene).
#
# What it does:
#   - For each managed log under $RADIO_HOME/logs/, if size > MAX_BYTES,
#     save the last TAIL_BYTES to <file>.last (so recent context survives),
#     then truncate the live file IN-PLACE (`: > file`).
#
# Why copytruncate (not move-and-signal):
#   - The engine is nohup'd and has an open append-mode fd on engine.log.
#     If we `mv engine.log engine.log.1` and create a new engine.log, the
#     engine's fd still points at the old inode, and future writes land
#     in engine.log.1 — not what cron-tail expects.
#   - `: > file` truncates the inode in place, leaving the engine's fd
#     pointing at the (now-empty) same file. The next append starts at
#     position 0. Lossy for whatever the engine wrote between our tail
#     copy and the truncate — the window is the duration of the tail
#     read (milliseconds for 5 MB on tmpfs, longer under IO pressure),
#     which is acceptable because the log is informational, not
#     transactional. cron.log gets rotated during a minute the watchdog
#     also writes to; same trade-off.
#
# Defaults are conservative for a personal Whatbox deploy (252 GB tmpfs,
# ~5 TB user disk):
#   - MAX_BYTES default: 50 MB. Triggered nightly per crontab.example.
#   - TAIL_BYTES default: 5 MB. Saved to <file>.last for post-mortem.
#
# Operator override via env (or before invocation):
#   LOG_ROTATE_MAX_BYTES=104857600 ~/webradio-v3/bin/log-rotate.sh
#
# Failure semantics:
#   - Missing log file → no-op (engine may not have started yet).
#   - LOG_DIR missing → no-op + non-zero exit (cron will mail the error).
#   - tail / : > / cp failures bubble up via set -e; cron logs them.

set -euo pipefail

# Tighten file creation perms so the brief moment between creat() and
# our explicit chmod 600 isn't a window for group/world-readable files
# under a permissive cron umask. (Codex P3 on PR #23.)
umask 077

RADIO_HOME="${RADIO_HOME:-$HOME/webradio-v3}"
LOG_DIR="$RADIO_HOME/logs"
RUN_DIR="$RADIO_HOME/run"
LOCK_FILE="$RUN_DIR/log-rotate.lock"
MAX_BYTES="${LOG_ROTATE_MAX_BYTES:-52428800}"   # 50 MB
TAIL_BYTES="${LOG_ROTATE_TAIL_BYTES:-5242880}"  # 5 MB

# Bail on garbage env values (cron treats stderr as mail).
case "$MAX_BYTES" in
  ''|*[!0-9]*) echo "log-rotate: LOG_ROTATE_MAX_BYTES must be a non-negative integer, got $MAX_BYTES" >&2; exit 2 ;;
esac
case "$TAIL_BYTES" in
  ''|*[!0-9]*) echo "log-rotate: LOG_ROTATE_TAIL_BYTES must be a non-negative integer, got $TAIL_BYTES" >&2; exit 2 ;;
esac
if [ "$TAIL_BYTES" -ge "$MAX_BYTES" ]; then
  echo "log-rotate: LOG_ROTATE_TAIL_BYTES ($TAIL_BYTES) must be less than LOG_ROTATE_MAX_BYTES ($MAX_BYTES)" >&2
  exit 2
fi

if [ ! -d "$LOG_DIR" ]; then
  echo "log-rotate: $LOG_DIR not found (engine never deployed?)" >&2
  exit 1
fi

# Single-instance lock so a manual run overlapping cron (or a hung
# previous run) can't race two truncates. Same pattern as start-engine
# and watchdog. RUN_DIR may not exist yet on a brand-new deploy; create
# it best-effort.
mkdir -p "$RUN_DIR" 2>/dev/null || true
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  # Another rotator is running — exit silently. Cron will retry tomorrow,
  # and the script is idempotent (rotate-if-too-large), so no work lost.
  exit 0
fi

# Files we manage. Anything else under logs/ is left alone (operator may
# have placed manual archives there).
LOGS=(engine.log cron.log)

rotate_one() {
  local file="$1"
  if [ ! -f "$file" ]; then
    # Log not yet created (e.g. first cron tick before engine ever ran).
    # No-op, no warning.
    return 0
  fi

  local size
  size=$(stat -c%s "$file")
  if [ "$size" -lt "$MAX_BYTES" ]; then
    return 0
  fi

  # Save the tail to a temp file in the same directory, then atomically
  # rename to <file>.last. If tail/cp is interrupted (signal, ENOSPC),
  # we keep the previous .last instead of clobbering it with a partial.
  # (Codex P2 on PR #23.)
  local tmp="$file.last.tmp.$$"
  if [ "$size" -gt "$TAIL_BYTES" ]; then
    tail -c "$TAIL_BYTES" "$file" > "$tmp"
  else
    cp -p "$file" "$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$file.last"

  # Truncate the live file in place (keeps inode → engine's open fd
  # remains valid).
  : > "$file"

  printf '[log-rotate] %s rotated %s (was %s bytes; tail saved to %s.last)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$file" "$size" "$file"
}

for name in "${LOGS[@]}"; do
  rotate_one "$LOG_DIR/$name"
done
