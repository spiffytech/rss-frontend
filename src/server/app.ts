// Hono app assembly. Public auth routes (session/login/logout) are registered
// first; the session gate + provider credential wrap everything else under
// /api/miniflux/*. `buildApp()` returns the app whose type drives the RPC
// client (hc<AppType>).
//
// IMPORTANT: buildApp must return a *chained* Hono expression so the route
// schema survives into AppType — that's what powers the end-to-end RPC client.

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { Database } from 'bun:sqlite'

import { readSession, writeSession, clearSession } from './lib/auth'
import { minifluxContext } from './lib/miniflux'
import { requestContext } from './lib/request-context'
import { loadConfig } from './lib/config'
import { minifluxProvider } from './providers/miniflux'
import { createProviderRoutes } from './providers/routes'

export function buildApp() {
  const providerRoutes = createProviderRoutes(minifluxProvider, {
    getUserId: () => requestContext.getStore()?.userId,
    gate: async (c, next) => {
      const session = readSession(c)
      if (!session?.token) {
        return c.json({ error: 'unauthorized' }, 401)
      }
      writeSession(c, session)
      return requestContext.run({ userId: session.userId }, () =>
        minifluxContext.run({ token: session.token }, () => next()),
      )
    },
  })

  return new Hono()
    // ---- Public: session status (SPA picks Login vs Reader) ----
    .get('/api/miniflux/session', (c) => {
      const session = readSession(c)
      return c.json({
        authenticated: session?.token != null,
        username: session?.username,
      })
    })

    // ---- Public: login ----
    .post(
      '/api/miniflux/login',
      zValidator('json', z.object({ username: z.string().min(1), password: z.string().min(1) })),
      async (c) => {
        const { username, password } = c.req.valid('json')
        const result = await minifluxProvider.authenticate(username, password)
        if (!result.ok) {
          return c.json({ error: 'invalid credentials' }, 401)
        }
        writeSession(c, {
          token: result.token,
          keyId: result.keyId,
          username: result.username,
          userId: result.userId,
        })
        return c.json({ ok: true })
      },
    )

    // ---- Public: logout ----
    .post('/api/miniflux/logout', async (c) => {
      const session = readSession(c)
      if (session) {
        await minifluxContext.run({ token: session.token }, () =>
          minifluxProvider.revokeKey(session.keyId),
        )
        clearSession(c)
      }
      return c.json({ ok: true })
    })

    // ---- Provider routes (gated inside) ----
    .route('/api/miniflux', providerRoutes)

    // ---- Health (container healthcheck: probes the real SQLite prefs file) ----
    .get('/health', (c) => {
      try {
        const probe = new Database(loadConfig().prefsDbPath)
        probe.run('PRAGMA busy_timeout = 5000')
        probe.exec('BEGIN IMMEDIATE; ROLLBACK;')
        probe.close()
      } catch (e) {
        return c.json({ status: 'unhealthy', reason: String(e) }, 503)
      }
      return c.json({ status: 'ok' })
    })
}

export type AppType = ReturnType<typeof buildApp>
