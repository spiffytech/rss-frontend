/**
 * The scheduler loop: decide when each feed should next be fetched and write
 * `feeds.next_check_at` in bulk.
 *
 * We are NOT the scheduler. Miniflux's own `feedScheduler` still calls
 * `ScheduleNextCheck` after every refresh and rewrites `next_check_at`, so we
 * reassert a value every tick. That only works while our tick period stays
 * below `SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL` (1 min vs 5 min by default):
 * break that invariant and we silently lose control of the feeds Miniflux
 * would poll faster than us. If this process dies, Miniflux keeps running on
 * its own entry_frequency values — that is the designed degradation.
 */
import type { SQL } from 'bun'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Schedule } from '../config'
import {
  acquireSchedulerLock,
  applyTargets,
  fetchFeeds,
  fetchLastInsertedAt,
  fetchLearnAggregates,
  fetchWeeklyEntryCounts,
  openDb,
  releaseSchedulerLock,
  type LearnAggregates,
  type TargetWrite,
} from './db'
import { lastTickAgeMinutes, markSchedulerStarted, markTick } from './heartbeat'
import {
  buildFeedModel,
  decodeCacheHintMinutes,
  entryFrequencyIntervalMinutes,
  expandMinuteCounts,
  minuteOfDay,
  nextPollInstant,
  retryOffsets,
  type FeedInput,
  type FeedModel,
} from './model'
import { notify } from './notify'

/**
 * Runtime kill switch. Touching this file stops us writing next_check_at at
 * all, so Miniflux's own ScheduleNextCheck values stand and the instance
 * reverts to ordinary entry_frequency behaviour on its next refresh. That is
 * the only correct way to abort: we stop asserting, we do not scribble over
 * the schedule on the way out. Removing the file resumes.
 */
const OFF_FLAG = join(dirname(process.env.prefsDbPath || './data/prefs.sqlite'), '.scheduler-off')

const TICK_MS = 60_000
/** The learned model only moves when new entries land; rebuilding every tick
 *  would re-aggregate the whole window 1440 times a day for nothing. */
const REBUILD_MS = 15 * 60_000
/** Ignore sub-minute churn so we are not rewriting next_check_at constantly. */
const TOLERANCE_MS = 60_000

interface ModelCache {
  builtAt: number
  models: Map<number, FeedModel>
}

/** Per-feed facts carried between ticks. In-memory only: losing them on
 *  restart costs one cycle of re-detection, never correctness. */
const prev = new Map<number, { checkedAt: number | null; lastCreated: number | null }>()

/** Decoded cache hints, keyed by feed and tagged with the checkedAt they were
 *  decoded from so a later fetch invalidates them. */
const hints = new Map<number, { checkedAt: number; minutes: number }>()

/**
 * A hung query must not kill the loop. `setTimeout(run, TICK_MS)` is only
 * reached AFTER `await tick(...)`, so one never-settling promise stops
 * scheduling for the life of the process — and Bun's SQL client exposes no
 * statement timeout to bound it. Racing a timer keeps the chain alive and
 * reports the stall instead of dying quietly.
 */
const TICK_TIMEOUT_MS = 120_000

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/**
 * Miniflux has no error backoff — RefreshFeed calls ScheduleNextCheck BEFORE
 * fetching and the error path writes that same value, so a broken feed is
 * retried at its entry-frequency interval forever. We own the backoff: 1h
 * doubling per consecutive failure, floored at the minimum interval (NOT the
 * entry-frequency interval, or feeds that merely look high-volume get
 * hammered) and capped so nothing is ever dead for good.
 *
 * `parsing_error_count` is the streak counter for free: model/feed.go
 * increments it per failure and zeroes it on success, and nothing else
 * mutates it.
 */
function probeIntervalMinutes(errorCount: number, s: Schedule): number {
  const exponent = Math.min(Math.max(errorCount, 1), 8) - 1
  return Math.min(
    Math.max(60 * 2 ** exponent, s.minIntervalMinutes),
    s.failingFeedMaxIntervalMinutes,
  )
}

function toInputs(agg: LearnAggregates): Map<number, FeedInput> {
  const out = new Map<number, FeedInput>()
  for (const [feedId, dayCounts] of agg.dayCounts) {
    const gapSeconds = agg.medGapSeconds.get(feedId)
    out.set(feedId, {
      feedId,
      stamps: expandMinuteCounts(agg.minuteCounts.get(feedId) ?? new Map()),
      dayCounts,
      medGapMinutes: gapSeconds === undefined ? null : gapSeconds / 60,
    })
  }
  return out
}

async function tick(sql: SQL, s: Schedule, cache: ModelCache | null): Promise<ModelCache> {
  const now = Date.now()
  const feeds = await fetchFeeds(sql)
  const lastInserted = await fetchLastInsertedAt(sql)
  const weekly = await fetchWeeklyEntryCounts(sql)

  let models = cache
  if (!models || now - models.builtAt > REBUILD_MS) {
    const agg = await fetchLearnAggregates(sql, s.learningWindowDays)
    const inputs = toInputs(agg)
    const built = new Map<number, FeedModel>()
    for (const [feedId, input] of inputs) {
      const model = buildFeedModel(input, {
        entryFrequencyFactor: s.entryFrequencyFactor,
        maxPollsPerDay: s.maxPollsPerDay,
        learningWindowDays: s.learningWindowDays,
      })
      if (model) built.set(feedId, model)
    }
    models = { builtAt: now, models: built }
  }

  const writes: TargetWrite[] = []
  for (const feed of feeds) {
    const model = models.models.get(feed.id)
    const created = lastInserted.get(feed.id) ?? null
    const before = prev.get(feed.id)
    const checkedAdvanced = feed.checkedAt != null && before?.checkedAt !== feed.checkedAt.getTime()
    // A refresh that advanced checked_at but not created_at caught nothing:
    // that is the signal to retry inside the bell.
    const caughtNothing = checkedAdvanced && created != null && before?.lastCreated === created.getTime()
    prev.set(feed.id, {
      checkedAt: feed.checkedAt?.getTime() ?? null,
      lastCreated: created?.getTime() ?? null,
    })

    const currentNext = feed.nextCheckAt?.getTime() ?? null

    // Decode Miniflux's cache hint. `checked_at` advancing proves Miniflux was
    // the last writer (UpdateFeed and UpdateFeedError write both columns
    // together; our writes never touch checked_at), so this is the ONLY tick on
    // which `next_check_at` is reliably Miniflux's. Decoding it at any other
    // time reads our own value as if it were the origin's and compounds it —
    // that bug pushed a feed 42 hours out before it was caught.
    //
    // Miniflux writes `interval = min(max(entryInterval, refreshDelay),
    // maxInterval)`, so the hint is whatever the observed interval exceeds the
    // entry-frequency interval by. A floor, not a target: the origin said "not
    // sooner than this" — honour it (especially Retry-After on a 429, which
    // also trips parsing_error_count and so activates the probe branch below).
    if (checkedAdvanced && feed.checkedAt != null && currentNext != null) {
      const checkedMs = feed.checkedAt.getTime()
      const entryIntervalMin = entryFrequencyIntervalMinutes(
        weekly.get(feed.id) ?? 0,
        s.entryFrequencyFactor,
        s.minIntervalMinutes,
        s.maxIntervalMinutes,
      )
      const observedMin = (currentNext - checkedMs) / 60_000
      hints.set(feed.id, {
        checkedAt: checkedMs,
        minutes: decodeCacheHintMinutes(observedMin, entryIntervalMin),
      })
    }

    // Every `now`-relative target is anchored to checkedAt, NOT to the current
    // tick. Recomputing `now + X` each 60s tick makes the deadline CHASE THE
    // CLOCK: the tolerance check below compares the recomputed value against the
    // previous write, sees a gap of one tick period, and rewrites — so the
    // deadline slides forward forever and never becomes due. That silently
    // disabled both the failing-feed probe backoff and the bell-retry chain.
    // checkedAt is a stable anchor (Miniflux writes it only on an actual fetch),
    // so the target holds still across ticks and the tolerance check lets it
    // stand. Measured before the fix: a failing feed's deadline advanced 60s
    // while only 15s of wall clock elapsed.
    const anchorMs = feed.checkedAt?.getTime() ?? now
    // Per-feed jitter band on the staleness bound. A shared checked_at produces
    // a shared bound, so every feed fetched together becomes due together 24h
    // later, gets fetched together again, and the cluster reproduces itself
    // forever. Measured before this fix: 85 feeds sharing one checked_at and 77
    // sharing another — a guaranteed daily stampede.
    //
    // Band width is sized from the worst observed cluster against the per-host
    // watchdog threshold (25 fetches / 10 min): the 29-feed youtube.com cluster
    // spread over B minutes yields 290/B per 10-min window, so a ~1 hour band
    // puts it at ~5 — a 5x margin. 4% of a 24h maxInterval is 57.6 min.
    const jitter = ((feed.id * 2654435761) >>> 0) / 4294967296 // 0..1, stable per feed
    const staleBoundMs = anchorMs + s.maxIntervalMinutes * 60_000 * (0.96 + 0.04 * jitter)
    let targetMs: number
    if (feed.parsingErrorCount > 0) {
      targetMs = anchorMs + probeIntervalMinutes(feed.parsingErrorCount, s) * 60_000
    } else {
      const next = model ? nextPollInstant(model, now) : null
      targetMs = next ? next.getTime() : staleBoundMs
      if (model && caughtNothing && feed.checkedAt != null) {
        // The anchor for a retry is the FETCH that caught nothing (checkedAt),
        // not the tick that noticed it.
        const checkedMs = feed.checkedAt.getTime()
        const offset = retryOffsets(model, minuteOfDay(checkedMs), feed.checkedAt.getUTCDay())[0]
        if (offset !== undefined) targetMs = Math.min(targetMs, anchorMs + offset * 60_000)
      }
    }

    // Staleness: never later than maxInterval since the last ACTUAL check. When
    // the bound is already past the feed is OVERDUE, and the target must be
    // allowed to land in the past too — Miniflux selects on
    // `next_check_at < now()`, so nudging an overdue target forward makes it
    // never due at all.
    // Staleness applies to HEALTHY feeds only. For a failing feed the probe
    // backoff is the politeness mechanism and must be allowed to reach
    // SCHEDULER_FAILING_FEED_MAX_INTERVAL_MINUTES; capping it at maxInterval
    // made that setting dead and probed broken feeds once a day regardless.
    if (feed.parsingErrorCount === 0) targetMs = Math.min(targetMs, staleBoundMs)

    const hint = hints.get(feed.id)
    if (hint != null && hint.checkedAt === anchorMs) {
      targetMs = Math.max(targetMs, anchorMs + hint.minutes * 60_000)
    }

    if (currentNext != null && Math.abs(targetMs - currentNext) <= TOLERANCE_MS) continue
    writes.push({ id: feed.id, target: new Date(targetMs), expectedCheckedAt: feed.checkedAtText })
  }

  await applyTargets(sql, writes)
  return models
}

/**
 * Start the loop. Returns a stop function, or null when disabled. A thrown
 * error inside the loop is caught and reported rather than allowed to kill the
 * process, because a dead scheduler silently reverts the instance to
 * entry_frequency.
 */
export function startScheduler(s: Schedule): (() => void) | null {
  if (!s.databaseUrl) {
    console.warn('scheduler: MINIFLUX_DATABASE_URL not set; external scheduling disabled')
    return null
  }
  const sql = openDb(s.databaseUrl)
  let cache: ModelCache | null = null
  let stopped = false
  let reportedOff = false
  let lockHeld = false

  markSchedulerStarted()
  void notify(s.ntfyUrl, 'miniflux scheduler started', `pid ${process.pid}`)

  const run = async () => {
    // Single-instance guard. The CAS on checked_at is not mutual exclusion —
    // neither writer changes checked_at, so two replicas both win it and
    // overwrite each other every tick. A session advisory lock releases itself
    // if this process dies, so there is no stale-lock recovery to get wrong.
    if (!lockHeld) {
      try {
        lockHeld = await acquireSchedulerLock(sql)
      } catch {
        // Transient connection failure — retry on the next tick.
      }
      if (!lockHeld) {
        if (!reportedOff) {
          reportedOff = true
          console.warn('scheduler: another instance holds the scheduler lock; not asserting')
          void notify(s.ntfyUrl, 'miniflux scheduler standby', 'another instance holds the lock')
        }
        markTick(true)
        if (!stopped) setTimeout(run, TICK_MS)
        return
      }
    }
    if (existsSync(OFF_FLAG)) {
      if (!reportedOff) {
        reportedOff = true
        console.warn(`scheduler: disabled via ${OFF_FLAG}; Miniflux is scheduling on its own`)
        void notify(s.ntfyUrl, 'miniflux scheduler disabled', `off-flag present at ${OFF_FLAG}`)
      }
      markTick(true)
      if (!stopped) setTimeout(run, TICK_MS)
      return
    }
    if (reportedOff) {
      reportedOff = false
      void notify(s.ntfyUrl, 'miniflux scheduler resumed', 'off-flag removed')
    }
    const gap = lastTickAgeMinutes()
    if (gap != null && gap > s.maxTickAgeMinutes) {
      void notify(s.ntfyUrl, 'miniflux scheduler gap', `resumed after ${gap.toFixed(0)} minutes`)
    }
    try {
      cache = await withTimeout(tick(sql, s, cache), TICK_TIMEOUT_MS, 'scheduler tick timed out')
      markTick(true)
    } catch (e) {
      console.error('scheduler: tick failed', e)
      markTick(false, String(e))
      void notify(s.ntfyUrl, 'miniflux scheduler tick failed', String(e))
    }
    if (!stopped) setTimeout(run, TICK_MS)
  }
  void run()

  return () => {
    stopped = true
    void (async () => {
      try {
        if (lockHeld) await releaseSchedulerLock(sql)
      } catch {
        // The session drop releases the lock regardless.
      }
      await sql.close()
    })()
  }
}
