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
  }
}
