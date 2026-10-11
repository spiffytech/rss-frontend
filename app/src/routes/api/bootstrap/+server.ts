import type { RequestHandler } from './$types'
import { z } from 'zod'

import { zodEntriesFilter } from '../../../shared/filter'
import { json, handle, requireUser } from '../../../server/api-helpers'
import { getAllFeedPrefs, getUserPrefs } from '../../../server/query/mutations'
import { panel, queryView } from '../../../server/query/views'

const body = z.object({ filter: zodEntriesFilter.optional() })

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  const filter = parsed.success ? (parsed.data.filter ?? {}) : {}
  const db = handle()
  const userPrefs = getUserPrefs(db.db, user.id)
  return json({
    ...queryView(db.db, { userId: user.id, filter }),
    ...panel(db.db, { userId: user.id, hideEmptyFeeds: userPrefs.hideEmptyFeeds === true }),
    userPrefs,
    feedPrefs: getAllFeedPrefs(db.db, user.id),
  })
}
