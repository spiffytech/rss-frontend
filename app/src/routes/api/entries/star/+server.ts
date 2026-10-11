import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'

import type { EntryId } from '../../../../shared/ids'
import { json, handle, requireUser } from '../../../../server/api-helpers'
import { setStarred } from '../../../../server/query/mutations'

const body = z.object({
  entryIds: z.array(z.string()).min(1).max(500),
  starred: z.boolean(),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  if (!parsed.success) error(400, 'invalid star payload')
  const changed = setStarred(handle().db, {
    userId: user.id,
    entryIds: parsed.data.entryIds as EntryId[],
    starred: parsed.data.starred,
  })
  return json({ changed })
}
