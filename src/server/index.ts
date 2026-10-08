// Server entry. Dev: serves the API on 3100 (Vite serves the SPA on 5173 and
// proxies /api). Production: serves the API + the built dist/ SPA on PORT.

import { serveStatic } from 'hono/bun'

import { buildApp } from './app'
import { loadConfig } from './lib/config'
import { startScheduler } from './lib/schedule'

const config = loadConfig()
const app = buildApp()

// External feed scheduler: writes feeds.next_check_at in Miniflux's Postgres on
// a 1-minute loop. Miniflux stays the fetcher/parser/store; we only move the
// pointer. No-op (with a warning) when MINIFLUX_DATABASE_URL is unset, so a
// `bun dev` without a database still boots.
startScheduler(config.schedule)

if (process.env.NODE_ENV === 'production') {
  // Serve everything in dist/: hashed assets under /assets/* plus the public/
  // files Vite copied in (favicon, manifest, icons, sw.js). One catch-all
  // serves any real file, so new public/ entries need no route here.
  // serveStatic falls through when a path doesn't exist, so the SPA fallback
  // below still catches client routes. Do NOT enumerate files with mid-path
  // globs like '/icon-*.png': buildApp() registers param routes, which makes
  // Hono pick TrieRouter, and TrieRouter only treats a *trailing* '*' as a
  // wildcard — a mid-path one matches literally and the file 404s to the SPA.
  app.use('*', serveStatic({ root: './dist' }))
  app.get('*', async (c) => c.html(await Bun.file('./dist/index.html').text()))
  const server = Bun.serve({
    port: Number(process.env.PORT) || 3000,
    fetch: app.fetch,
  })
  console.log(`miniflux-frontend listening on ${server.url}`)
} else {
  // Dev: API only — Vite (5173) proxies /api to this port.
  const server = Bun.serve({
    port: 3100,
    fetch: app.fetch,
  })
  console.log(`miniflux-frontend API listening on ${server.url}`)
}
