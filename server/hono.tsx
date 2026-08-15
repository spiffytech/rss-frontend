import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { logger } from 'hono/logger'

import { indexRoutes } from './routes/index'
import { apiRoutes } from './routes/api'
import { readSession, writeSession, clearSession } from './lib/auth'
import { minifluxContext, MinifluxError, authenticateWithPassword, createApiKey, deleteApiKey } from './lib/miniflux'
import { loadConfig } from './lib/config'

const app = new Hono()
app.use(logger())

// The HTML shell is fully server-rendered and changes with every deploy —
// never let the browser serve a stale copy (a cached old build is a real
// source of "bugs that are already fixed"). Static assets are content-address
// stable enough for a short cache + revalidation.
app.use('/api/*', async (ctx, next) => {
  await next()
  ctx.header('Cache-Control', 'no-store')
})
app.use('/style.css', async (ctx, next) => {
  await next()
  ctx.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')
})
app.use('/*', async (ctx, next) => {
  await next()
  if (!ctx.res.headers.get('Cache-Control')) {
    ctx.header('Cache-Control', 'no-cache')
  }
})

// ---------------- Auth ----------------

/** Login body from either a JS fetch (JSON) or a plain form POST (urlencoded). */
async function readBody(ctx: { req: { header: (n: string) => string | undefined; json: () => Promise<unknown>; parseBody: () => Promise<Record<string, unknown>> } }): Promise<Record<string, string>> {
  const raw = await (() => {
    const ct = ctx.req.header('content-type') ?? ''
    return ct.includes('application/json') ? ctx.req.json() : ctx.req.parseBody()
  })()
  const body = (raw || {}) as Record<string, unknown>
  return {
    username: typeof body.username === 'string' ? body.username : '',
    password: typeof body.password === 'string' ? body.password : '',
  }
}

/** Public paths that never require a session. */
const PUBLIC_PATHS = new Set([
  '/login',
  '/style.css',
  '/favicon.svg',
])

/**
 * Gate every route behind a session. A valid signed session cookie sets the
 * request-scoped Miniflux credential (AsyncLocalStorage) for the whole
 * request — including async SSE streams — so datastar patching re-uses the
 * logged-in user's key, never a shared one.
 */
app.use('/*', async (ctx, next) => {
  const { pathname } = new URL(ctx.req.url)

  // Public: login page + login POST + logout POST + static assets.
  if (PUBLIC_PATHS.has(pathname) || (pathname === '/api/login' && ctx.req.method === 'POST') || (pathname === '/api/logout' && ctx.req.method === 'POST')) {
    return next()
  }

  const session = readSession(ctx)
  if (!session?.token) {
    if (pathname.startsWith('/api/')) {
      return ctx.json({ error: 'unauthorized' }, 401)
    }
    return ctx.redirect('/login')
  }

  // Set the per-request Miniflux credential and run the route inside it.
  return minifluxContext.run({ token: session.token }, () => next())
})

/** Minimal login page (no styling dep — reuses app CSS). */
app.get('/login', (ctx) =>
  ctx.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign in — Miniflux Reader</title>
    <link rel="icon" href="/favicon.svg" />
    <link rel="stylesheet" href="/style.css" />
    <style>
      /* One authored entrance: the card rises and fades from an already-visible
         default. Reduced-motion users get the static composited state. */
      @media (prefers-reduced-motion: no-preference) {
        .login-card { animation: login-rise 420ms cubic-bezier(0.16, 1, 0.3, 1); }
        @keyframes login-rise {
          from { opacity: 0; transform: translateY(12px); }
          to   { opacity: 1; transform: none; }
        }
      }
    </style>
  </head>
  <body class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
    <main class="w-full max-w-sm">
      <form method="post" action="/api/login" class="login-card bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6">
        <div class="flex flex-col items-center gap-3 text-center">
          <svg aria-hidden="true" viewBox="0 0 32 32" class="w-14 h-14">
            <rect width="32" height="32" rx="6" fill="#0e7490"/>
            <text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="white">M</text>
          </svg>
          <div class="flex flex-col gap-1.5">
            <h1 class="text-lg font-semibold leading-6">Sign in to Miniflux Reader</h1>
            <p class="text-sm text-gray-500 leading-5">
              Uses your Miniflux username and password. A session-only API key is created for this browser and revoked on logout.
            </p>
          </div>
        </div>
        <div class="flex flex-col gap-4">
          <label class="flex flex-col gap-1.5 text-sm font-medium">
            <span>Miniflux username</span>
            <input
              name="username"
              required
              autocomplete="username"
              class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
            />
          </label>
          <label class="flex flex-col gap-1.5 text-sm font-medium">
            <span>Miniflux password</span>
            <input
              name="password"
              type="password"
              required
              autocomplete="current-password"
              class="border border-gray-300 rounded-md px-3 py-2 text-sm font-normal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-cyan-700 focus:border-cyan-700"
            />
          </label>
        </div>
        <button
          type="submit"
          class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px disabled:opacity-60 disabled:translate-y-0"
        >
          <span class="inline-flex items-center gap-2 justify-center">
            Sign in
          </span>
        </button>
        <p id="err" role="alert" class="text-sm text-red-600 hidden">Sign-in failed. Check your credentials.</p>
        <script>
          (() => {
            const form = document.querySelector('form')
            const btn = form.querySelector('button[type=submit]')
            form.addEventListener('submit', async (e) => {
              e.preventDefault()
              const f = e.target
              const err = document.getElementById('err')
              err.classList.add('hidden')
              btn.disabled = true
              try {
                const res = await fetch('/api/login', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username: f.username.value, password: f.password.value }),
                })
                if (res.ok) { location.href = '/' } else {
                  err.classList.remove('hidden')
                  f.password.value = ''
                }
              } finally {
                btn.disabled = false
              }
            })
          })()
        </script>
      </form>
    </main>
  </body>
</html>`),
)

/**
 * POST /api/login — validate credentials against Miniflux, mint a per-session
 * API key, and set the signed session cookie. Reuses the bootstrap env token
 * only for the key-creation call itself until the session is established.
 */
app.post('/api/login', async (ctx) => {
  const { username, password } = await readBody(ctx)
  if (!username || !password) {
    return ctx.json({ error: 'username and password required' }, 400)
  }
  try {
    await authenticateWithPassword(username, password)
  } catch (err) {
    if (err instanceof MinifluxError && (err.status === 401 || err.status === 403)) {
      return ctx.json({ error: 'invalid credentials' }, 401)
    }
    throw err
  }
  // Inside the bootstrap credential context, create a per-session API key.
  const { id, token } = await minifluxContext.run(
    { token: loadConfig().minifluxApiToken },
    () => createApiKey(`miniflux-frontend session ${new Date().toISOString()}`),
  )
  writeSession(ctx, { token, keyId: id, username })
  return ctx.json({ ok: true })
})

/** POST /api/logout — revoke the session API key and clear the cookie. */
app.post('/api/logout', async (ctx) => {
  const session = readSession(ctx)
  if (session) {
    try {
      await minifluxContext.run({ token: session.token }, () => deleteApiKey(session.keyId))
    } catch {
      // Key may already be gone (e.g. revoked elsewhere); clear locally anyway.
    }
    clearSession(ctx)
  }
  return ctx.redirect('/login')
})

// ---------------- Static + routes ----------------

app.use('/*', serveStatic({ root: './public' }))

app.route('/', indexRoutes)
app.route('/', apiRoutes)

export default app
