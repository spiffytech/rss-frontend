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
import { isTickStale } from './lib/schedule/heartbeat'
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
    // Intentionally UNAUTHENTICATED and intentionally inert: it is reachable
    // from outside, so it returns no error text, no paths, no config, and it
    // opens the database read-only (no file creation, no write lock). It is
    // safe to expose precisely because there is nothing here to learn or to
    // abuse — reaching for auth would only break external uptime probes.
    .get('/health', (c) => {
      const cfg = loadConfig()
      // Deliberately non-sensitive. This endpoint is unauthenticated, so the
      // response carries no exception text, no filesystem paths and no config —
      // a generic reason is all a probe needs. Opening the database READ-ONLY
      // also removes two side effects the old probe had: `new Database(path)`
      // silently CREATES the file when it is missing, and `BEGIN IMMEDIATE`
      // takes the prefs write lock on every unauthenticated request (a trivial
      // lock-contention vector). Read-only still fails on a corrupt or missing
      // database, which is what we actually need to know.
      try {
        const probe = new Database(cfg.prefsDbPath, { readonly: true })
        probe.close()
      } catch {
        return c.json({ status: 'unhealthy', reason: 'prefs database unavailable' }, 503)
      }
      // The scheduler runs as a setInterval inside this process, so a silently
      // stalled loop would otherwise pass this check forever while the instance
      // quietly reverted to Miniflux's own entry_frequency. Only enforced once
      // the scheduler is actually enabled, so a DB-less dev boot stays healthy.
      if (isTickStale(cfg.schedule.maxTickAgeMinutes)) {
        return c.json({ status: 'unhealthy', reason: 'scheduler tick is stale' }, 503)
      }
      return c.json({ status: 'ok' })
    })
}

export type AppType = ReturnType<typeof buildApp>
