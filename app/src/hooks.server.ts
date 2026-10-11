import type { Handle } from '@sveltejs/kit/hooks'

import { readSession, SESSION_COOKIE } from './server/auth'

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.user = readSession(event.cookies.get(SESSION_COOKIE))
  return resolve(event)
}
