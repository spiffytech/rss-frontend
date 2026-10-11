import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'

import type { FeedId } from '../../../../shared/ids'
import { handle, requireUser } from '../../../../server/api-helpers'
import { feedIcons, icons } from '../../../../server/db/schema'

export const GET: RequestHandler = ({ params, locals }) => {
  const user = requireUser(locals)
  const db = handle()
  const row = db.db
    .select({ mimeType: icons.mimeType, data: icons.data })
    .from(feedIcons)
    .innerJoin(icons, eq(feedIcons.iconId, icons.id))
    .where(eq(feedIcons.feedId, params.id as FeedId))
    .get()
  if (!row) error(404, 'no icon')
  void user
  return new Response(new Uint8Array(row.data), {
    headers: {
      'content-type': row.mimeType,
      'cache-control': 'private, max-age=86400',
    },
  })
}
