import type { RequestHandler } from './$types'
import { json, handle, requireUser } from '../../../server/api-helpers'
import { getUserPrefs } from '../../../server/query/mutations'
import { panel } from '../../../server/query/views'

export const GET: RequestHandler = ({ locals }) => {
  const user = requireUser(locals)
  const db = handle()
  return json(panel(db.db, { userId: user.id, hideEmptyFeeds: getUserPrefs(db.db, user.id).hideEmptyFeeds === true }))
}
