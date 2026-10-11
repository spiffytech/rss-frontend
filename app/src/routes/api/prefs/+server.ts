import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'

import type { FeedId } from '../../../shared/ids'
import { json, handle, requireUser } from '../../../server/api-helpers'
import { getAllFeedPrefs, getUserPrefs, setFeedPrefs, setUserPrefs } from '../../../server/query/mutations'

const feedPatch = z
  .object({
    viewMode: z.enum(['expanded', 'list']).optional(),
    sort: z.enum(['oldest', 'newest']).optional(),
    hideReadItems: z.boolean().optional(),
    hiddenKeywords: z.array(z.string()).optional(),
    hiddenAuthors: z.array(z.string()).optional(),
    hiddenTags: z.array(z.string()).optional(),
  })
  .strict()

const userPatch = z
  .object({
    hideEmptyFeeds: z.boolean().optional(),
    disabledAutoReadFeeds: z.array(z.string()).optional(),
  })
  .strict()

const body = z.object({
  feedId: z.string().optional(),
  patch: z.union([feedPatch, userPatch]),
})

export const GET: RequestHandler = ({ locals }) => {
  const user = requireUser(locals)
  const db = handle()
  return json({ userPrefs: getUserPrefs(db.db, user.id), feedPrefs: getAllFeedPrefs(db.db, user.id) })
}

export const PUT: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  if (!parsed.success) error(400, 'invalid prefs payload')
  const db = handle()
  if (parsed.data.feedId) {
    const feed = feedPatch.safeParse(parsed.data.patch)
    if (!feed.success) error(400, 'invalid feed prefs')
    setFeedPrefs(db.db, user.id, parsed.data.feedId as FeedId, feed.data)
  } else {
    const prefs = userPatch.safeParse(parsed.data.patch)
    if (!prefs.success) error(400, 'invalid user prefs')
    setUserPrefs(db.db, user.id, {
      hideEmptyFeeds: prefs.data.hideEmptyFeeds,
      disabledAutoReadFeeds: prefs.data.disabledAutoReadFeeds?.map((id) => id as FeedId),
    })
  }
  return json({ ok: true })
}
