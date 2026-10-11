import { error, json } from '@sveltejs/kit'

import type { SessionUser } from './auth'
import { appDb } from './db-app'
import type { ReaderHandle } from './db'

export function requireUser(locals: App.Locals): SessionUser {
  if (!locals.user) error(401, 'not authenticated')
  return locals.user
}

export function handle(): ReaderHandle {
  return appDb()
}

export { json }
