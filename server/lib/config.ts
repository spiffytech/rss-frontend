export interface Config {
  minifluxUrl: string
  minifluxApiToken: string
  sessionSecret: string
}

export function loadConfig(): Config {
  const minifluxUrl = process.env.MINIFLUX_URL
  const minifluxApiToken = process.env.MINIFLUX_API_TOKEN
  const sessionSecret = process.env.SESSION_SECRET

  if (!minifluxUrl) {
    throw new Error('MINIFLUX_URL is not set. Set it in a .env file.')
  }
  // The API token is needed at minimum as a bootstrap credential: the first
  // login validates a password against Miniflux, but session-less deploys and
  // admin access rely on it too. It also parallels the pre-auth setup path.
  if (!minifluxApiToken) {
    throw new Error('MINIFLUX_API_TOKEN is not set. Set it in a .env file.')
  }
  if (!sessionSecret) {
    throw new Error('SESSION_SECRET is not set. Set it to a long random string.')
  }

  return {
    minifluxUrl: minifluxUrl.replace(/\/+$/, ''),
    minifluxApiToken,
    sessionSecret,
  }
}
