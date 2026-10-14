import type { Handle } from '@sveltejs/kit/hooks'

import { readSession, SESSION_COOKIE } from './server/auth'
import { appDb } from './server/db-app'
import { startScheduler } from './server/scheduler'

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = readSession(event.cookies.get(SESSION_COOKIE))
  return resolve(event)
}

// The scheduler runs in this process — one process owns the SQLite file. The
// globalThis guard keeps vite HMR in dev from stacking a second loop.
const g = globalThis as typeof globalThis & { __readerSchedulerStop?: (() => void) | null }
if (g.__readerSchedulerStop === undefined) {
  try {
    g.__readerSchedulerStop = startScheduler({ handle: appDb() })
  } catch (error) {
    console.error('scheduler: failed to start', error)
    g.__readerSchedulerStop = null
  }
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.once(sig, () => g.__readerSchedulerStop?.())
  }
}
