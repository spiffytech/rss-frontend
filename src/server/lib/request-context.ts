// Request-scoped context (AsyncLocalStorage). The auth middleware stores the
// session's userId here so provider routes can key the pref store without
// threading the session through every handler. Nesting inside
// minifluxContext.run (the provider credential) keeps both request-scoped.

import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestContext {
  userId?: number
}

export const requestContext = new AsyncLocalStorage<RequestContext>()
