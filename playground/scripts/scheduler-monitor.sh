#!/usr/bin/env bash
# Scheduler monitor for the standalone reader (app/).
#
# Runs one SQLite/health pass per cycle inside the container and logs a single
# STATS line. An ALARM line means a hard threshold was crossed; the job watcher
# greps for "ALARM" and wakes the operator. Everything else is for eyeballing.
#
# Replaces the old feed-watchdog.sh, which queried Miniflux's Postgres and held
# the off switch for a scheduler it could no longer see.
#
#   DIR    log location          (default ~/.cache/miniflux-scheduler)
#   CYCLE  seconds between runs  (default 180)
set -uo pipefail

DIR="${PI_SCRATCH_DIR:-$HOME/.cache/miniflux-scheduler}"
CYCLE="${CYCLE:-180}"
LOG="$DIR/scheduler-monitor.log"
TRIP="$DIR/scheduler-monitor.ALARM"
HERE="$(cd "$(dirname "$0")" && pwd)"
QUERY="$HERE/scheduler-monitor.mjs"
CLUSTER="${CLUSTER:-homelab-spfy}"
SERVICE="${SERVICE:-miniflux-frontend}"

mkdir -p "$DIR"

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

log "monitor start pid=$$ cycle=${CYCLE}s log=$LOG query=$QUERY"

while :; do
  out="$(uc -c "$CLUSTER" exec -T "$SERVICE" -- sh -c \
    'cat > /tmp/mon.mjs && bun /tmp/mon.mjs' < "$QUERY" 2>/dev/null)"

  if [ -z "$out" ]; then
    line="ALARM monitor-blind -- cannot read $SERVICE"
    log "$line"
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $line" >> "$TRIP"
  else
    while IFS= read -r line; do
      log "$line"
      case "$line" in
        ALARM*) echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $line" >> "$TRIP" ;;
      esac
    done <<< "$out"
  fi

  sleep "$CYCLE"
done
