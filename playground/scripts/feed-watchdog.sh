#!/bin/bash
# Feed-fetch watchdog. Checks every CYCLE seconds and, if polling looks
# pathological, SHUTS THE SCHEDULER DOWN by dropping the runtime off-flag.
#
# It deliberately does NOT touch next_check_at. Killing the scheduler means we
# stop asserting and Miniflux's own ScheduleNextCheck values stand, so the
# instance reverts to ordinary entry_frequency behaviour on its next refresh.
# The UI keeps serving throughout -- only the scheduler loop goes quiet.
# Removing the off-flag resumes.
#
# THRESHOLDS ARE CALIBRATED AGAINST MEASURED BEHAVIOUR, NOT FEEL:
#   observed healthy = 371 fetches/day, 13/hour average, 103 in the peak hour
#                    = ~2 fetches/10min average, 17/10min at peak
#   the deployed scheduler targets ~1.5x that, so ~25/10min is still healthy
#   anything above ~3x observed peak is not traffic, it is a stampede
#
# NOTE ON THE METRIC: `checked_at` is a single overwritten timestamp per feed,
# so it cannot report historical fetch counts. "feeds touched in the last N
# minutes" is therefore a LOWER BOUND on requests -- good enough to catch a
# stampede, not good enough for billing-grade accounting.
#
# One log line per cycle. A line starting "TRIP" is what the job watcher
# matches on to wake the operator.

set -uo pipefail

CYCLE=180            # 3 minutes
WINDOW=10            # minutes of history each check looks at
# Per-host IS the politeness risk ("don't hammer anyone's site"), so that is
# the primary trip. Total volume is NOT: the learned placement legitimately
# bunches ~25% of feeds into the evening-US window (94 touched/10min observed,
# 5 max to any one host), so a low total threshold is a false-positive machine.
# Total is kept only as a catastrophic guard.
MAX_FETCH=400        # catastrophic total (natural peak observed: 94/10min)
MAX_HOST=25          # distinct feeds touched on ONE host in WINDOW (observed max: 5)
MAX_DUE_SOON=400     # feeds whose next_check_at lands in the next 5 minutes

DIR="${PI_SCRATCH_DIR:-$HOME/.cache/miniflux-scheduler}"
LOG="$DIR/watchdog.log"
TRIP="$DIR/watchdog.TRIPPED"
mkdir -p "$DIR"

q() {
  uc -c homelab-spfy exec -T postgres -- sh -c \
    "psql -U \"\$POSTGRES_USER\" -d miniflux -t -A -c \"$1\"" 2>/dev/null | tr -d ' '
}

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" | tee -a "$LOG"
}

# Shut the scheduler down WITHOUT touching next_check_at -- see the header.
shut_down_scheduler() {
  local why="$1"
  uc -c homelab-spfy exec -T miniflux-frontend -- touch /data/.scheduler-off >/dev/null 2>&1
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) TRIP $why -- scheduler shut down (UI unaffected), Miniflux back to entry_frequency" \
    | tee -a "$LOG" "$TRIP"
}

while true; do
  fetched=$(q "SELECT count(*) FROM feeds WHERE checked_at > now() - interval '$WINDOW minutes'")
  due5=$(q "SELECT count(*) FROM feeds WHERE disabled=false AND next_check_at BETWEEN now() AND now()+interval '5 minutes'")
  errors=$(q "SELECT count(*) FROM feeds WHERE disabled=false AND parsing_error_count > 0")
  hostmax=$(q "
    SELECT coalesce(max(n), 0) FROM (
      SELECT substring(feed_url from 'https?://([^/]+)') AS host, count(*) AS n
      FROM feeds
      WHERE checked_at > now() - interval '$WINDOW minutes'
      GROUP BY 1
    ) t")

  log "touched${WINDOW}m=$fetched due5=$due5 host${WINDOW}mmax=$hostmax errors=$errors"

  if [ "${hostmax:-0}" -gt "$MAX_HOST" ]; then
    shut_down_scheduler "host${WINDOW}mmax=$hostmax > $MAX_HOST on one host"
  elif [ "${fetched:-0}" -gt "$MAX_FETCH" ]; then
    shut_down_scheduler "touched${WINDOW}m=$fetched > $MAX_FETCH (catastrophic; natural peak 94)"
  elif [ "${due5:-0}" -gt "$MAX_DUE_SOON" ]; then
    shut_down_scheduler "due5=$due5 > $MAX_DUE_SOON (stampede queued)"
  fi

  sleep "$CYCLE"
done
