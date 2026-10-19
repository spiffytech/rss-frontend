import { Database } from 'bun:sqlite'

// Scheduler monitor. Emits one STATS line per cycle, plus ALARM lines when a
// hard threshold is crossed. Thresholds are calibrated against measured steady
// state, not set by feel -- see the numbers in each comment.

const db = new Database('/data/reader.sqlite', { readonly: true })
const rows = (sql, ...a) => db.query(sql).all(...a)
const NOW = Date.now()

// Hard thresholds.
const HOST_MAX_10MIN = 25 // measured steady state is 1-3 per host per 10 min.
const BACKLOG_MAX = 200 // drains at 12/tick = 720/h; only a wedged loop gets here.
const TICK_AGE_MAX_MIN = 5 // matches /health's own staleness verdict.

const alarms = []

// --- liveness: the scheduler's own heartbeat ---
let tickAge = -1
try {
  const r = await fetch('http://127.0.0.1:3000/health')
  const j = await r.json()
  tickAge = j?.scheduler?.tickAgeMinutes ?? -1
  if (!j?.ok || tickAge > TICK_AGE_MAX_MIN)
    alarms.push(`scheduler-stalled tickAge=${tickAge} ok=${j?.ok}`)
} catch (e) {
  alarms.push(`health-unreachable ${String(e).slice(0, 60)}`)
}

// --- politeness: per-host fetch rate ---
// checked_at advances on every fetch, so it is the fetch log. No extra table.
const hostMax = rows(
  `SELECT coalesce(max(n), 0) AS m FROM (
     SELECT count(*) AS n FROM feeds
      WHERE checked_at > ?
      GROUP BY substr(feed_url, instr(feed_url,'//')+2,
                      instr(substr(feed_url, instr(feed_url,'//')+2), '/')-1))`,
  NOW - 600e3,
)[0].m
if (hostMax > HOST_MAX_10MIN) alarms.push(`host-rate host10mmax=${hostMax} > ${HOST_MAX_10MIN}`)

// --- throughput: feeds due but not yet taken ---
const backlog = rows(`SELECT count(*) c FROM feeds WHERE next_check_at < ? AND NOT disabled`, NOW)[0].c
if (backlog > BACKLOG_MAX) alarms.push(`backlog ${backlog} > ${BACKLOG_MAX}`)

// --- quality: publish-to-read latency of recent fetches ---
const lat = rows(
  `SELECT (created_at - published_at) / 60000.0 AS m FROM entries
    WHERE created_at > ? AND published_at > 1609459200000
    ORDER BY m`,
  NOW - 6 * 3600e3,
).map((r) => r.m)
const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null)
const f = (v) => (v == null ? '-' : v.toFixed(0))

// --- visibility: feeds sitting quiet while we are not looking for >6h ---
// This is the shape that hid the QC miss: publishes arrived while the one daily
// poll had already gone, and nothing looked again for a day. Reported, not
// alarming -- legitimate weekly feeds land here too. Eye it, do not trip on it.
const behind = rows(
  `SELECT count(*) c FROM (
     SELECT f.id, (? - MAX(e.published_at)) / 3600000.0 AS quiet_h,
            (f.next_check_at - ?) / 3600000.0 AS next_in_h,
            MAX(e.created_at) AS newest_got
       FROM feeds f JOIN entries e ON e.feed_id = f.id
      WHERE NOT f.disabled
      GROUP BY f.id
     HAVING quiet_h > 36 AND next_in_h > 6 AND newest_got > ?)`,
  NOW, NOW, NOW - 7 * 864e5,
)[0].c

console.log(
  `STATS tick=${tickAge} backlog=${backlog} host10mmax=${hostMax} ` +
    `lat_n=${lat.length} p50=${f(q(0.5))} p90=${f(q(0.9))} behind=${behind}`,
)
for (const a of alarms) console.log(`ALARM ${a}`)
