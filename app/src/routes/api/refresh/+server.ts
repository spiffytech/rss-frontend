import type { RequestHandler } from './$types'
import { and, eq, inArray } from 'drizzle-orm'

import { json, handle, requireUser } from '../../../server/api-helpers'
import { feeds } from '../../../server/db/schema'
import { zodEntriesFilter } from '../../../shared/filter'
import { epochMs } from '../../../shared/ids'

/**
 * Kick a refresh for the current view's feeds.
 *
 * The old app's Refresh asked Miniflux to poll those feeds and returned
 * immediately — Miniflux queued the work, so nothing was ever awaited. Ours
 * marks the feeds due now and lets the scheduler take them on its next tick
 * (≤60s). A freshly marked feed carries the earliest target, so a single-feed
 * refresh sits at the head of the fetch queue rather than behind the backlog.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
  const user = requireUser(locals)
  const db = handle()
  const body = (await request.json()) as { filter?: unknown }
  const filter = zodEntriesFilter.parse(body.filter ?? {})

  const owned = db.db
    .select({ id: feeds.id, categoryId: feeds.categoryId })
    .from(feeds)
    .where(eq(feeds.userId, user.id))
    .all()
  const targets = owned.filter((feed) => {
    if (filter.feedId) return feed.id === filter.feedId
    if (filter.categoryId) return feed.categoryId === filter.categoryId
    return true
  })
  if (targets.length === 0) return json({ queued: 0 })

  db.db
    .update(feeds)
    .set({ nextCheckAt: epochMs(Date.now()) })
    .where(
      and(
        eq(feeds.userId, user.id),
        inArray(
          feeds.id,
          targets.map((feed) => feed.id),
        ),
      ),
    )
    .run()
  return json({ queued: targets.length })
}
