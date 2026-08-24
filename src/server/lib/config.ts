export interface Config {
  minifluxUrl: string
  sessionSecret: string
  /** Path to the SQLite file holding per-account reader preferences. */
  prefsDbPath: string
}

/** Hardcoded dev-only fallback so `bun dev` boots with no env. Never used in
 *  production — loadConfig requires a real sessionSecret when NODE_ENV is
 *  production (the Dockerfile/compose set it). The secret signs the session
 *  cookie, which carries the user's live Miniflux API key, so it must be
 *  unpredictable outside local dev. */
const DEV_SESSION_SECRET = 'dev-only-insecure-session-secret-do-not-use'

export function loadConfig(): Config {
  const minifluxUrl = process.env.minifluxUrl
  const isProd = process.env.NODE_ENV === 'production'
  const sessionSecret = process.env.sessionSecret ?? (isProd ? undefined : DEV_SESSION_SECRET)

  if (!minifluxUrl) {
    throw new Error('minifluxUrl is not set. Set it in a .env file.')
  }
  if (!sessionSecret) {
    throw new Error('sessionSecret is not set. Set it to a long random string.')
  }

  return {
    minifluxUrl: minifluxUrl.replace(/\/+$/, ''),
    sessionSecret,
    prefsDbPath: process.env.prefsDbPath || './data/prefs.sqlite',
  }
}
