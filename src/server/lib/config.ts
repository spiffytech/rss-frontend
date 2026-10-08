import { resolve } from 'node:path'

export interface Config {
  minifluxUrl: string
  /**
   * HMAC key for session cookies. NULL means UNSIGNED dev mode — the cookie
   * then carries no authenticity guarantee at all, which is why `loadConfig`
   * only permits it when NODE_ENV is exactly 'development'.
   */
  sessionSecret: string | null
  /** Path to the SQLite file holding per-account reader preferences. */
  prefsDbPath: string
  /** Poll-rate bounds, shared with Miniflux itself. See {@link Schedule}. */
  schedule: Schedule
}

/**
 * Poll-rate bounds, read from the SAME env vars Miniflux reads
 * (`SCHEDULER_ENTRY_FREQUENCY_*`) so the scheduler can never disagree with the
 * instance it is driving. Miniflux parses these as minuteType, so "5" means
 * 5 minutes — the values here are minutes, not seconds.
 */
export interface Schedule {
  /** Fastest we may poll any one feed. Miniflux: MIN_INTERVAL. */
  minIntervalMinutes: number
  /** Slowest we may poll any one feed. Miniflux: MAX_INTERVAL. */
  maxIntervalMinutes: number
  /** Miniflux's entry_frequency multiplier, used when we fall back to its formula. */
  entryFrequencyFactor: number
  /** Ceiling on polls per feed per day: 1440 / minIntervalMinutes. */
  maxPollsPerDay: number
  /** Floor on polls per feed per day: 1440 / maxIntervalMinutes. */
  /** How far back to learn from published_at. Also the FIXED denominator of the
   *  no-weekday-signal rate -- do not shorten it to "catch up faster". */
  learningWindowDays: number
  /**
   * Half-life, in days, of the item-rate EMA. Smaller tracks a feed that
   * changes pace faster; larger is smoother but slower to notice. 7 means a
   * feed that goes from 4 to 30 items/day is ~87% caught up within a week.
   */
  rateHalfLifeDays: number
  /** Ceiling on the failing-feed probe backoff (1h doubling). */
  failingFeedMaxIntervalMinutes: number
  /** /health reports 503 once the last completed loop tick is older than this. */
  maxTickAgeMinutes: number
  /** Miniflux's Postgres. Null disables the scheduler entirely. */
  databaseUrl: string | null
  /** ntfy topic URL. Empty means alerts are disabled. */
  ntfyUrl: string
}

/**
 * There is deliberately NO hardcoded fallback secret. Signing is skipped only
 * in explicit development mode (see `loadConfig`), so nothing here can leak a
 * known key into a real deployment.
 */
const MINUTES_PER_DAY = 1440

/** Miniflux's own defaults, so a missing var means "whatever Miniflux does". */
const DEFAULT_MIN_INTERVAL_MINUTES = 5
const DEFAULT_MAX_INTERVAL_MINUTES = 1440
const DEFAULT_ENTRY_FREQUENCY_FACTOR = 1
const DEFAULT_LEARNING_WINDOW_DAYS = 90
const DEFAULT_RATE_HALF_LIFE_DAYS = 7
const DEFAULT_FAILING_FEED_MAX_INTERVAL_MINUTES = 10080 // 7d
const DEFAULT_MAX_TICK_AGE_MINUTES = 5

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`)
  }
  return n
}

function loadSchedule(): Schedule {
  const minIntervalMinutes = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL',
    DEFAULT_MIN_INTERVAL_MINUTES,
  )
  const maxIntervalMinutes = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL',
    DEFAULT_MAX_INTERVAL_MINUTES,
  )
  const entryFrequencyFactor = numEnv(
    'SCHEDULER_ENTRY_FREQUENCY_FACTOR',
    DEFAULT_ENTRY_FREQUENCY_FACTOR,
  )

  if (minIntervalMinutes <= 0) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL must be > 0')
  }
  if (maxIntervalMinutes <= 0) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL must be > 0')
  }
  // Miniflux refuses to start on this (internal/config/parser.go). Fail the
  // same way rather than silently scheduling against contradictory bounds.
  if (minIntervalMinutes > maxIntervalMinutes) {
    throw new Error(
      'SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL must be <= SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL',
    )
  }
  if (entryFrequencyFactor < 1) {
    throw new Error('SCHEDULER_ENTRY_FREQUENCY_FACTOR must be >= 1')
  }

  return {
    minIntervalMinutes,
    maxIntervalMinutes,
    entryFrequencyFactor,
    maxPollsPerDay: MINUTES_PER_DAY / minIntervalMinutes,
    learningWindowDays: numEnv('SCHEDULER_LEARNING_WINDOW_DAYS', DEFAULT_LEARNING_WINDOW_DAYS),
    rateHalfLifeDays: numEnv('SCHEDULER_RATE_HALF_LIFE_DAYS', DEFAULT_RATE_HALF_LIFE_DAYS),
    failingFeedMaxIntervalMinutes: numEnv(
      'SCHEDULER_FAILING_FEED_MAX_INTERVAL_MINUTES',
      DEFAULT_FAILING_FEED_MAX_INTERVAL_MINUTES,
    ),
    maxTickAgeMinutes: numEnv('SCHEDULER_MAX_TICK_AGE_MINUTES', DEFAULT_MAX_TICK_AGE_MINUTES),
    databaseUrl: process.env.MINIFLUX_DATABASE_URL || null,
    ntfyUrl: process.env.MINIFLUX_SCHEDULER_NTFY_URL || '',
  }
}

export function loadConfig(): Config {
  const minifluxUrl = process.env.minifluxUrl
  // Dev is signalled EXPLICITLY, never inferred from "not production". A
  // missing or mistyped NODE_ENV must fail to boot rather than silently drop
  // session signing — an unsigned cookie is trivially forgeable, and the
  // cookie carries the user's live Miniflux API key.
  const isDev = process.env.NODE_ENV === 'development'
  const sessionSecret = process.env.sessionSecret || null

  if (!minifluxUrl) {
    throw new Error('minifluxUrl is not set. Set it in a .env file.')
  }
  if (!isDev && !sessionSecret) {
    throw new Error(
      'sessionSecret is not set. It signs session cookies that carry live Miniflux API keys. ' +
        'Set it to a long random string, or set NODE_ENV=development to explicitly opt into unsigned dev cookies.',
    )
  }

  return {
    minifluxUrl: minifluxUrl.replace(/\/+$/, ''),
    sessionSecret,
    prefsDbPath: resolve(process.env.prefsDbPath || './data/prefs.sqlite'),
    schedule: loadSchedule(),
  }
}
