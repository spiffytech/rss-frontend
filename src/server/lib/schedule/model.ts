/**
 * Pure feed-scheduling model. No I/O — everything here is unit-testable.
 *
 * Ported from the validated reference implementation at
 * playground/scripts/poll-sim.ts (`simulate()` placement/budget logic).
 * Times of day are UTC minutes 0..1439; days are UTC epoch-day numbers.
 */

export const MINUTES_PER_DAY = 1440
const MS_PER_DAY = 86_400_000

// ---- density / modes ----
const DENSITY_BINS = 48
const BIN_MINUTES = MINUTES_PER_DAY / DENSITY_BINS // 30
const SMOOTH_PASSES = 3
const CONCENTRATION_RATIO = 3 // concentrated = peak > 3 * mean
const MODE_PEAK_FRACTION = 0.2 // bin must reach 20% of peak to be a mode
const RAW_MODE_SUPPORT = 3 // a mode needs >= 3 raw samples in its bin

// ---- budget ----
const DATE_ONLY_MIN_POLLUTES = 3
const MIN_DOW_SAMPLES = 12 // weekday gate needs >= 12 DISTINCT active days to mean anything

// ---- placement ----
const SINGLE_POLL_QUANTILE = 0.85

export interface FeedInput {
  feedId: number
  /** Minute-of-day (0..1439) of every published entry in the window, with multiplicity. */
  stamps: number[]
  /** Entry count per UTC day (epoch-day number -> count). */
  dayCounts: Map<number, number>
  /** Median gap between consecutive published_at values, in minutes; null when < 2 entries. */
  medGapMinutes: number | null
}

export interface ScheduleOptions {
  /** SCHEDULER_ENTRY_FREQUENCY_FACTOR — multiplies items-expected-today. */
  entryFrequencyFactor: number
  /** Ceiling on polls per feed per day. */
  maxPollsPerDay: number
  /**
   * SCHEDULER_LEARNING_WINDOW_DAYS. Used as the FIXED denominator of the
   * no-weekday-signal rate — see the budget comment below.
   */
  learningWindowDays: number
  /**
   * SCHEDULER_RATE_HALF_LIFE_DAYS — how fast the item-rate EMA tracks a feed
   * that changes pace. See {@link emaDailyCount}.
   */
  rateHalfLifeDays: number
  /** UTC epoch-day of "today"; the EMA is anchored here. */
  nowEpochDay: number
}

export interface FeedModel {
  feedId: number
  /** All entries stamped midnight exactly: no time-of-day signal exists. */
  dateOnly: boolean
  /** Density has a peak > 3x its mean. */
  concentrated: boolean
  numModes: number
  peak: number
  /** Poll budget per weekday (0 = Sunday). */
  budget: number[]
  medGapMinutes: number | null
  dowSignal: boolean
  publishDays: Set<number>
  /** Cached poll placement (minutes-of-day, ascending) for a weekday's budget. */
  pollMinutes(dow: number): number[]
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

/** UTC day-of-week (0 = Sunday) for an epoch-day number. */
export function dayOfWeek(epochDay: number): number {
  return new Date(epochDay * MS_PER_DAY).getUTCDay()
}

/** UTC epoch-day number for a timestamp. */
export function epochDay(ms: number): number {
  return Math.floor(ms / MS_PER_DAY)
}

/** Minute-of-day (0..1439) for a timestamp, truncated to whole minutes. The
 *  double modulo keeps pre-1970 (negative) timestamps positive — JS `%` keeps
 *  the sign of the dividend, so `minuteOfDay` would otherwise return negatives
 *  and silently break its 0..1439 contract. */
export function minuteOfDay(ms: number): number {
  return Math.floor((((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / 60_000)
}

/** Expand a minute-of-day count histogram back into a stamp multiset. */
export function expandMinuteCounts(minuteCounts: Map<number, number>): number[] {
  const stamps: number[] = []
  for (const [minute, count] of minuteCounts) {
    for (let i = 0; i < count; i++) stamps.push(minute)
  }
  return stamps
}

/**
 * Seam rotation: cut the circular day at its quietest 30-minute bin so the
 * wrap point never splits a mode. Rotating by -seamBin*30 turns the circle
 * into a line where quantiles are well defined. Everything downstream
 * (quantiles) works on rotated minutes; `toOrig` maps back at the end.
 */
function rotate(stamps: number[]): { rot: number[]; seamBin: number } {
  const hist = new Array<number>(DENSITY_BINS).fill(0)
  for (const s of stamps) {
    const bin = Math.floor((((s % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY) / BIN_MINUTES)
    hist[bin] = (hist[bin] as number) + 1
  }
  // First strictly-smallest bin wins ties (matches the sim's scan order).
  let seam = 0
  for (let i = 1; i < DENSITY_BINS; i++) {
    if ((hist[i] as number) < (hist[seam] as number)) seam = i
  }
  const rot = stamps
    .map((s) => (((s - seam * BIN_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY)
    .sort((a, b) => a - b)
  return { rot, seamBin: seam }
}

/** Weighted empirical quantile (linear interpolation) over a sorted multiset. */
function quantile(sorted: number[], t: number): number {
  if (sorted.length === 0) return 0
  const idx = clamp(t * (sorted.length - 1), 0, sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(sorted.length - 1, lo + 1)
  return (sorted[lo] as number) + (idx - lo) * ((sorted[hi] as number) - (sorted[lo] as number))
}

/**
 * Exponentially weighted item rate, in items/day, over the learning window.
 *
 * This replaces a flat `N / learningWindowDays` average, which cannot follow a
 * feed that changes pace: a feed averaging 3.6 items/day and then publishing
 * 30/day still earned a budget of ~4 and missed items for hours.
 *
 * It is SAFER than the mean-gap formula it replaces, not merely different.
 * That pathology derived a rate from GAPS — two entries five minutes apart
 * make the denominator collapse and yield 288 items/day. A per-day count
 * cannot be inflated by clustering: those two entries are 2 on one day, so the
 * EMA sees 2. Clustering within a day is invisible to it by construction.
 */
export function emaDailyCount(
  dayCounts: Map<number, number>,
  nowEpochDay: number,
  halfLifeDays: number,
  learnDays: number,
): number {
  const alpha = 1 - Math.pow(2, -1 / Math.max(halfLifeDays, 0.1))
  const decay = 1 - alpha
  let ema = 0
  // Oldest -> newest so today's sample carries weight alpha.
  for (let k = learnDays - 1; k >= 0; k--) {
    ema = ema * decay + (dayCounts.get(nowEpochDay - k) ?? 0) * alpha
  }
  // Normalise the truncated tail. The window cuts off the infinite series, so
  // without this a constant rate r reads as r*(1 - decay^learnDays) — a silent
  // underestimate whenever the window is not many half-lives long. With it, a
  // steady feed reports exactly its rate for ANY half-life.
  const mass = 1 - Math.pow(decay, learnDays)
  return mass > 1e-9 ? ema / mass : ema
}

export function buildFeedModel(input: FeedInput, opts: ScheduleOptions): FeedModel | null {
  const stamps = input.stamps.filter((s) => s >= 0 && s < MINUTES_PER_DAY)
  const N = stamps.length
  if (N === 0) return null

  // Date-only feeds: every entry stamped exactly midnight UTC — no time-of-day
  // signal exists, so polls are spread uniformly instead of chasing a phantom mode.
  const dateOnly = stamps.every((s) => s === 0)

  const { rot, seamBin } = rotate(stamps)
  const toOrig = (v: number) => (((v + seamBin * BIN_MINUTES) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY

  // 48-bin density over rotated minutes, smoothed 3x with the circular
  // [1,2,1]/4 kernel. densAt() rotates its query minute the same way, so this
  // is equivalent to the sim's unrotated histogram plus a raw-minute lookup.
  const dh = new Array<number>(DENSITY_BINS).fill(0)
  for (const s of stamps) {
    const bin = Math.floor((((s - seamBin * BIN_MINUTES) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY) / BIN_MINUTES)
    dh[bin] = (dh[bin] as number) + 1
  }
  let dens = dh
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    dens = dens.map(
      (_, i) =>
        0.25 * (dens[(i - 1 + DENSITY_BINS) % DENSITY_BINS] as number) +
        0.5 * (dens[i] as number) +
        0.25 * (dens[(i + 1) % DENSITY_BINS] as number),
    )
  }
  const peak = Math.max(...dens)
  const meanDens = dens.reduce((a, b) => a + b, 0) / DENSITY_BINS
  const concentrated = peak > CONCENTRATION_RATIO * meanDens

  // Count significant modes so a bimodal feed cannot starve its minority mode.
  // The RAW-count support requirement is essential: without it sparse feeds
  // get phantom modes from the smoothing alone.
  let numModes = 1
  if (concentrated) {
    numModes = 0
    for (let i = 0; i < DENSITY_BINS; i++) {
      const prev = dens[(i - 1 + DENSITY_BINS) % DENSITY_BINS] as number
      const next = dens[(i + 1) % DENSITY_BINS] as number
      const hit =
        (dens[i] as number) >= MODE_PEAK_FRACTION * peak &&
        (dens[i] as number) >= prev &&
        (dens[i] as number) > next &&
        (dh[i] as number) >= RAW_MODE_SUPPORT
      if (hit) numModes++
    }
    numModes = Math.max(1, numModes)
  }

  const activeDays = input.dayCounts.size
  const learnDays = opts.learningWindowDays

  // Weekday gate: only trust the day-of-week pattern with enough DISTINCT days,
  // and count days rather than entries. Counting entries lets one burst invent
  // a weekly commitment -- 20 entries on a single Tuesday would claim
  // "publishes on Tuesdays" and spend the whole burst budget every Tuesday
  // forever, on one day of evidence.
  const dowDays = new Array<number>(7).fill(0)
  for (const day of input.dayCounts.keys()) {
    const dow = dayOfWeek(day)
    dowDays[dow] = (dowDays[dow] as number) + 1
  }
  const publishDays = new Set<number>()
  // A weekday counts as a publish day if it carries at least half the AVERAGE
  // number of active days. The previous fixed share (0.12) was far too fragile:
  // a feed that posts every day lands at ~1/7 = 0.143 per weekday, so ordinary
  // sampling noise can drop one weekday below 0.12, flip dowSignal on, and give
  // every excluded weekday a budget of 1. That silently turned Hacker News
  // (65 items/day) into a once-a-day feed.
  const minDaysPerDow = Math.max(1, activeDays / 14)
  for (let d = 0; d < 7; d++) {
    if ((dowDays[d] as number) >= minDaysPerDow) publishDays.add(d)
  }
  const dowSignal = activeDays >= MIN_DOW_SAMPLES && publishDays.size > 0 && publishDays.size < 7

  // Budget = items expected TODAY.
  //
  // The rate is an EMA of per-day entry counts (see emaDailyCount), not a flat
  // window average, so it follows a feed that accelerates. `perActiveDay`
  // scales it back to "per day it actually posts" so the weekday gate can
  // spend it all on a publish day: with no weekday signal the two factors
  // cancel and the budget is just the EMA itself.
  const ratePerDay = emaDailyCount(input.dayCounts, opts.nowEpochDay, opts.rateHalfLifeDays, learnDays)
  const perActiveDay = (ratePerDay * learnDays) / Math.max(1, activeDays)
  // ceil() with an epsilon: the EMA is iterative float arithmetic, so a feed
  // that is exactly N/day can compute as N+1e-12 and ceil() it up to N+1. The
  // old flat formula was exact integer arithmetic and never hit this.
  const CEIL_EPS = 1e-9
  // The floor must never exceed the ceiling: a date-only feed on an instance
  // configured for < 3 polls/day would otherwise get clamp(x, 3, 2) = 3 and
  // silently poll MORE often than the configured maximum.
  const floorPolls = Math.min(dateOnly ? DATE_ONLY_MIN_POLLUTES : 1, opts.maxPollsPerDay)
  const budget: number[] = []
  for (let d = 0; d < 7; d++) {
    const p = dowSignal ? (publishDays.has(d) ? 1 : 0) : activeDays / learnDays
    budget.push(
      clamp(
        Math.max(
          Math.ceil(perActiveDay * p * opts.entryFrequencyFactor - CEIL_EPS),
          p >= 1 ? numModes : 1,
        ),
        floorPolls,
        opts.maxPollsPerDay,
      ),
    )
  }

  // Placement depends only on B, so cache one schedule per distinct B.
  const ptCache = new Map<number, number[]>()
  const pollMinutes = (dow: number): number[] => {
    const b = budget[dow] ?? 1
    const hit = ptCache.get(b)
    if (hit) return hit
    const pts: number[] = []
    if (dateOnly) {
      // No time-of-day signal: uniform coverage of the day.
      for (let k = 1; k <= b; k++) pts.push(((k - 0.5) * MINUTES_PER_DAY) / b)
    } else if (b === 1) {
      // One poll: put it past the bulk of the mode (85th percentile) so
      // little arrives after it within the day.
      pts.push(toOrig(quantile(rot, SINGLE_POLL_QUANTILE)))
    } else {
      // Median of each equal-mass slice: sits inside the bell, so a
      // multimodal distribution gets one poll per mode region.
      for (let k = 1; k <= b; k++) pts.push(toOrig(quantile(rot, (k - 0.5) / b)))
    }
    pts.sort((x, y) => x - y)
    const uniq: number[] = []
    for (const t of pts) {
      if (!uniq.length || t - (uniq[uniq.length - 1] as number) > 1) uniq.push(t)
    }
    ptCache.set(b, uniq)
    return uniq
  }

  const medGapMinutes = input.medGapMinutes

  return {
    feedId: input.feedId,
    dateOnly,
    concentrated,
    numModes,
    peak,
    budget,
    medGapMinutes,
    dowSignal,
    publishDays,
    pollMinutes,
  }
}

/**
 * Miniflux's entry-frequency interval, replicated exactly (internal/model/feed.go
 * `ScheduleNextCheck`) so the cache-hint decoder can subtract it and isolate the
 * hint Miniflux folded in via `max(interval, refreshDelay)`.
 */
export function entryFrequencyIntervalMinutes(
  weeklyCount: number,
  factor: number,
  minIntervalMinutes: number,
  maxIntervalMinutes: number,
): number {
  const raw = weeklyCount > 0 ? (7 * 24 * 60) / (weeklyCount * factor) : maxIntervalMinutes
  return Math.min(Math.max(raw, minIntervalMinutes), maxIntervalMinutes)
}

/**
 * Recover Miniflux's cache hint from what it wrote.
 *
 * Miniflux persists `interval = min(max(entryInterval, refreshDelay), maxInterval)`,
 * and its two clock readings STRADDLE the fetch — so `observed` also contains the
 * fetch duration. Combining the two:
 *
 *   refreshDelay <= entry  ->  observed == entry (+fetch)      -> no hint
 *   refreshDelay >  entry  ->  observed == refreshDelay (+fetch) -> hint = observed
 *
 * So the hint is the whole observed gap, never `observed - entry`: subtracting
 * under-honours a Retry-After by exactly one entry interval. Slack absorbs the
 * fetch duration; anything at or below `entry` is genuinely indistinguishable
 * from no hint at all (the max() collapsed it) and must read as none.
 *
 * Only sound to call on the tick where `checked_at` advanced: that is the one
 * moment when `next_check_at` is provably Miniflux's and not our own previous
 * write.
 */
const HINT_SLACK_MINUTES = 3 // fetch time is inside the observed gap

export function decodeCacheHintMinutes(
  observedMinutes: number,
  entryIntervalMinutes: number,
): number {
  return observedMinutes > entryIntervalMinutes + HINT_SLACK_MINUTES ? observedMinutes : 0
}

/**
 * A target we already committed to is replaced only by an EARLIER one.
 *
 * Two failures come from not doing this:
 *   - a retry target (checkedAt + 5..30min) gets rewritten to the next bell one
 *     tick later, so the retry chain never fires;
 *   - a target that expired before Miniflux's batch consumed it is raised to
 *     the following bell — "never due at all", the exact failure the staleness
 *     rule exists to prevent.
 *
 * `justFetched` is the one exception: on that tick `currentNextMs` is Miniflux's
 * own freshly-written entry-frequency default rather than our plan, so it has
 * to be replaceable — otherwise a sparse feed is pinned to Miniflux's rate
 * instead of its learned bell.
 *
 * `hintFloorMs` is the origin's Retry-After / cache floor: the one thing allowed
 * to push a target back out.
 */
export function resolveTarget(
  candidateMs: number,
  currentNextMs: number | null,
  justFetched: boolean,
  hintFloorMs?: number,
): number {
  let t = candidateMs
  if (!justFetched && currentNextMs != null) t = Math.min(t, currentNextMs)
  if (hintFloorMs != null) t = Math.max(t, hintFloorMs)
  return t
}

/**
 * Earliest scheduled poll instant strictly after `afterMs`, scanning UTC day
 * offsets 0..maxDayOffset and each poll minute of that day's budget.
 */
export function nextPollInstant(
  model: FeedModel,
  afterMs: number,
  maxDayOffset = 7,
): Date | null {
  const base = epochDay(afterMs) * MS_PER_DAY
  for (let off = 0; off <= maxDayOffset; off++) {
    const dayStart = base + off * MS_PER_DAY
    const dow = new Date(dayStart).getUTCDay()
    for (const m of model.pollMinutes(dow)) {
      const t = dayStart + m * 60_000
      if (t > afterMs) return new Date(t)
    }
  }
  return null
}
