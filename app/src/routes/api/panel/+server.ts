import type { RequestHandler } from './$types'
import { json, handle, requireUser } from '../../../server/api-helpers'
import { getUserPrefs } from '../../../server/query/mutations'
import { panel } from '../../../server/query/views'
import { DEFAULT_HIDE_EMPTY_FEEDS } from '../../../shared/prefs'
import type { FeedId } from '../../../shared/ids'

export const GET: RequestHandler = ({ locals, url }) => {
  const user = requireUser(locals)
  const db = handle()
  return json(
    panel(db.db, {
      userId: user.id,
      hideEmptyFeeds: getUserPrefs(db.db, user.id).hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS,
      // The view's feed, so the header can name it even when the sidebar hides it.
      currentFeed: (url.searchParams.get('feed') as FeedId | null) ?? null,
    }),
  )
}
