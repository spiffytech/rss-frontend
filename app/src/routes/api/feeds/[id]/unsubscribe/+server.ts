import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'

import type { FeedId } from '../../../../../shared/ids'
import { json, handle, requireUser } from '../../../../../server/api-helpers'
import { unsubscribeFeed } from '../../../../../server/query/mutations'

export const POST: RequestHandler = async ({ params, locals }) => {
  const user = requireUser(locals)
  const db = handle()
  const ok = unsubscribeFeed(db, { userId: user.id, feedId: params.id as FeedId })
  if (!ok) error(404, 'feed not found')
  return json({ ok: true })
}
