/**
 * Postgres access for the scheduler: reads Miniflux's own tables (entries,
 * feeds) and writes `feeds.next_check_at` via a bulk CAS. All learning
 * aggregation is pushed into SQL — nothing here loops per feed.
 *
 * Everything is computed in UTC (`AT TIME ZONE 'UTC'`) on purpose:
 * consistency matters more than local-time correctness, and the weekday
 * gate is shifted uniformly for late-US/Eastern feeds.
 */
import { SQL } from 'bun'

export interface FeedRow {
  id: number
  userId: number
  /** Miniflux's last fetch time (ms precision — for change detection only). */
  checkedAt: Date | null
  /**
   * The same timestamp as TEXT, at full microsecond precision. This is the
   * only value safe to use as the CAS anchor: postgres `timestamptz` carries
   * microseconds but a JS Date can only hold milliseconds, so binding a Date
   * back never matches the stored row and every write is silently rejected.
   */
  checkedAtText: string | null
  /** Current scheduler value (Miniflux or us — whoever wrote last). */
  nextCheckAt: Date | null
  parsingErrorCount: number
}

export interface LearnAggregates {
  /** feedId -> (UTC epoch day -> entry count) */
  dayCounts: Map<number, Map<number, number>>
  /** feedId -> (minute-of-day -> entry count) */
  minuteCounts: Map<number, Map<number, number>>
  /** feedId -> median gap between consecutive published_at, in seconds */
  medGapSeconds: Map<number, number>
}

/** Open a client for Miniflux's Postgres. Connection is lazy. */
export function openDb(url: string): SQL {
  return new SQL({ url })
}

const LEARN_FILTER = `published_at > now() - $1 * interval '1 day'
  AND published_at > '2000-01-01'`

/** Per (feed_id, day) and (feed_id, minute-of-day) counts plus median gaps. */
export async function fetchLearnAggregates(sql: SQL, learningWindowDays: number): Promise<LearnAggregates> {
  const dayRows = await sql.unsafe<{ feed_id: number; day: number; count: number }[]>(
    `SELECT feed_id,
            ((published_at AT TIME ZONE 'UTC')::date - DATE '1970-01-01')::int AS day,
            count(*)::int AS count
       FROM entries
      WHERE ${LEARN_FILTER}
      GROUP BY 1, 2`,
    [learningWindowDays],
  )
  const minuteRows = await sql.unsafe<{ feed_id: number; minute: number; count: number }[]>(
    `SELECT feed_id,
            (EXTRACT(HOUR FROM published_at AT TIME ZONE 'UTC') * 60
             + EXTRACT(MINUTE FROM published_at AT TIME ZONE 'UTC'))::int AS minute,
            count(*)::int AS count
       FROM entries
      WHERE ${LEARN_FILTER}
      GROUP BY 1, 2`,
    [learningWindowDays],
  )
  const gapRows = await sql.unsafe<{ feed_id: number; med_gap_seconds: number }[]>(
    `WITH gaps AS (
       SELECT feed_id,
              EXTRACT(EPOCH FROM published_at
                      - lag(published_at) OVER (PARTITION BY feed_id ORDER BY published_at)) AS gap
         FROM entries
        WHERE ${LEARN_FILTER}
     )
     SELECT feed_id,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY gap)::float8 AS med_gap_seconds
       FROM gaps
      WHERE gap IS NOT NULL
      GROUP BY 1`,
    [learningWindowDays],
  )

  const dayCounts = new Map<number, Map<number, number>>()
  for (const row of dayRows) {
    // Postgres bigint comes back as a STRING from this driver. Coerce every
    // numeric column explicitly: a Map keyed by "16" silently misses get(16),
    // and that is exactly how the scheduler learned nothing at all while
    // looking healthy.
    const feedId = Number(row.feed_id)
    let m = dayCounts.get(feedId)
    if (!m) dayCounts.set(feedId, (m = new Map()))
    m.set(Number(row.day), Number(row.count))
  }
  const minuteCounts = new Map<number, Map<number, number>>()
  for (const row of minuteRows) {
    const feedId = Number(row.feed_id)
    let m = minuteCounts.get(feedId)
    if (!m) minuteCounts.set(feedId, (m = new Map()))
    m.set(Number(row.minute), Number(row.count))
  }
  const medGapSeconds = new Map<number, number>()
  for (const row of gapRows) medGapSeconds.set(Number(row.feed_id), Number(row.med_gap_seconds))

  return { dayCounts, minuteCounts, medGapSeconds }
}

export async function fetchFeeds(sql: SQL): Promise<FeedRow[]> {
  const rows = await sql.unsafe<{
    id: number
    user_id: number
    checked_at_text: string | null
    checked_at: Date | string | null
    next_check_at: Date | string | null
    parsing_error_count: number
  }[]>(
    `SELECT id, user_id,
            checked_at::text AS checked_at_text,
            checked_at, next_check_at, parsing_error_count
       FROM feeds`,
  )
  return rows.map((r) => ({
    id: Number(r.id),
    userId: Number(r.user_id),
    checkedAt: r.checked_at == null ? null : new Date(r.checked_at),
    checkedAtText: r.checked_at_text,
    nextCheckAt: r.next_check_at == null ? null : new Date(r.next_check_at),
    parsingErrorCount: Number(r.parsing_error_count),
  }))
}

/**
 * Entry count over the trailing 7 days per feed. Miniflux's own weeklyCount is
 * derived from data span (a bug we avoid elsewhere) — but the cache-hint decode
 * must recompute the entry-frequency interval exactly as Miniflux schedules it,
 * and for that this count is the input the spec prescribes.
 */
export async function fetchWeeklyCounts(sql: SQL): Promise<Map<number, number>> {
  const rows = await sql.unsafe<{ feed_id: number; count: number }[]>(
    `SELECT feed_id, count(*)::int AS count
       FROM entries
      WHERE published_at > now() - interval '7 days'
        AND published_at > '2000-01-01'
      GROUP BY 1`,
  )
  return new Map(rows.map((r) => [Number(r.feed_id), Number(r.count)]))
}

/**
 * Miniflux's `WeeklyFeedEntryCount`, replicated exactly (internal/storage/feed.go)
 * so the cache-hint decoder can separate Miniflux's own interval from the hint
 * it folded in. Note this is NOT `count(*)`: it is `ceil(week / mean_gap)` where
 * `mean_gap = (max - min)/(count - 1)`, and it returns 0 for 0 or 1 entries.
 */
export async function fetchWeeklyEntryCounts(sql: SQL): Promise<Map<number, number>> {
  const rows = await sql.unsafe<{ feed_id: number | string; weekly_count: number | string }[]>(
    `SELECT feed_id,
            COALESCE(CAST(CEIL(
              (EXTRACT(epoch from interval '1 week')) /
              NULLIF((EXTRACT(epoch from (max(published_at)-min(published_at))
                              / NULLIF((count(*)-1), 0))), 0)
            ) AS BIGINT), 0) AS weekly_count
       FROM entries
      WHERE published_at >= now() - interval '1 week'
      GROUP BY feed_id`,
  )
  return new Map(rows.map((r) => [Number(r.feed_id), Number(r.weekly_count)]))
}

/**
 * Last insert time per feed — the runtime's "did the last poll catch nothing?"
 * signal: Miniflux stamps created_at at insert time, so a fetch at T caught
 * something iff an entry exists with created_at >= T. (created_at is only
 * import-corrupted for old rows, which read as "caught nothing" — harmless.)
 */
export async function fetchLastInsertedAt(sql: SQL): Promise<Map<number, Date>> {
  const rows = await sql.unsafe<{ feed_id: number; last_created: Date | string }[]>(
    `SELECT feed_id, max(created_at) AS last_created
       FROM entries
      GROUP BY 1`,
  )
  return new Map(rows.map((r) => [Number(r.feed_id), new Date(r.last_created)]))
}

/**
 * Session-level advisory lock proving this process is the only scheduler. The
 * compare-and-swap on checked_at is NOT mutual exclusion — neither writer
 * changes checked_at, so two replicas both win the CAS and overwrite each other
 * every tick. A session lock releases automatically when the process dies, so
 * there is no stale-lock recovery to get wrong.
 *
 * Returns true when acquired, false when another scheduler already holds it.
 */
export async function acquireSchedulerLock(sql: SQL): Promise<boolean> {
  // Arbitrary but stable constant namespace + key.
  const rows = await sql.unsafe<{ locked: boolean }[]>(
    `SELECT pg_try_advisory_lock(726401339, 1) AS locked`,
  )
  return rows[0]?.locked === true
}

/** Release the advisory lock. Best-effort: the session drop releases it anyway. */
export async function releaseSchedulerLock(sql: SQL): Promise<void> {
  await sql.unsafe(`SELECT pg_advisory_unlock(726401339, 1)`)
}

export interface TargetWrite {
  id: number
  target: Date
  /** The checked_at value read this cycle, as lossless TEXT — the CAS anchor. */
  expectedCheckedAt: string | null
}

/**
 * Bulk compare-and-swap, one statement per cycle. Matching on checked_at
 * means we never clobber a concurrent Miniflux write: a feed missing from the
 * RETURNING set moved underneath us and is simply recomputed next cycle.
 * `IS NOT DISTINCT FROM` (not `=`) so a NULL checked_at still matches exactly.
 */
export async function applyTargets(sql: SQL, writes: TargetWrite[]): Promise<Set<number>> {
  if (writes.length === 0) return new Set()
  const params: unknown[] = []
  const tuples = writes.map((w, i) => {
    const base = i * 3
    params.push(w.id, w.target, w.expectedCheckedAt)
    return `($${base + 1}::bigint, $${base + 2}::timestamptz, $${base + 3}::timestamptz)`
  })
  const rows = await sql.unsafe<{ id: number }[]>(
    `UPDATE feeds AS f SET next_check_at = v.target
       FROM (VALUES ${tuples.join(', ')}) AS v(id, target, expected_checked_at)
      WHERE f.id = v.id
        AND f.checked_at IS NOT DISTINCT FROM v.expected_checked_at::timestamptz
      RETURNING f.id`,
    params,
  )
  return new Set(rows.map((r) => Number(r.id)))
}
