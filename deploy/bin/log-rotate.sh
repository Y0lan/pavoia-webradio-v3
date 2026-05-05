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
#     copy and the truncate, but the window is sub-millisecond and the
#     log is informational, not transactional.
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

RADIO_HOME="${RADIO_HOME:-$HOME/webradio-v3}"
LOG_DIR="$RADIO_HOME/logs"
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

  # Save the tail before truncating. If the whole file is shorter than
  # TAIL_BYTES (shouldn't happen given the size>MAX_BYTES gate above,
  # but defensive), fall back to a full copy.
  if [ "$size" -gt "$TAIL_BYTES" ]; then
    tail -c "$TAIL_BYTES" "$file" > "$file.last"
  else
    cp -p "$file" "$file.last"
  fi
  chmod 600 "$file.last"

  # Truncate the live file in place (keeps inode → engine's open fd
  # remains valid).
  : > "$file"

  printf '[log-rotate] %s rotated %s (was %s bytes; tail saved to %s.last)\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$file" "$size" "$file"
}

for name in "${LOGS[@]}"; do
  rotate_one "$LOG_DIR/$name"
done
