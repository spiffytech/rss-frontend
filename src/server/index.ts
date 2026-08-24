// Server entry. Dev: serves the API on 3100 (Vite serves the SPA on 5173 and
// proxies /api). Production: serves the API + the built dist/ SPA on PORT.

import { serveStatic } from 'hono/bun'

import { buildApp } from './app'

const app = buildApp()

if (process.env.NODE_ENV === 'production') {
  // Serve the whole build: hashed JS/CSS under /assets/* (immutable) plus the
  // public/ files Vite copied into dist/ (favicon, manifest, icons, sw.js).
  // serveStatic falls through (404) when the path doesn't exist, so the SPA
  // fallback below still catches client routes. The fallback index is served
  // no-cache so a redeploy never serves a stale shell.
  app.use('/assets/*', serveStatic({ root: './dist' }))
  app.use('/favicon.svg', serveStatic({ root: './dist' }))
  app.use('/favicon.ico', serveStatic({ root: './dist' }))
  app.use('/manifest.webmanifest', serveStatic({ root: './dist' }))
  app.use('/sw.js', serveStatic({ root: './dist' }))
  app.use('/apple-touch-icon.png', serveStatic({ root: './dist' }))
  app.use('/icon-*.png', serveStatic({ root: './dist' }))
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
