import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'

import type { EntryId } from '../../../../shared/ids'
import { json, handle, requireUser } from '../../../../server/api-helpers'
import { markEntries } from '../../../../server/query/mutations'

const body = z.object({
  entryIds: z.array(z.string()).min(1).max(500),
  status: z.enum(['read', 'unread']),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  if (!parsed.success) error(400, 'invalid status payload')
  const changed = markEntries(handle().db, {
    userId: user.id,
    entryIds: parsed.data.entryIds as EntryId[],
    status: parsed.data.status,
  })
  return json({ changed })
}
