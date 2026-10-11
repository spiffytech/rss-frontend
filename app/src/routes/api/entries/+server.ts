import type { RequestHandler } from './$types'
import { z } from 'zod'

import { zodEntriesFilter } from '../../../shared/filter'
import { epochMs, type EntryId } from '../../../shared/ids'
import { json, handle, requireUser } from '../../../server/api-helpers'
import { queryView } from '../../../server/query/views'

const body = z.object({
  filter: zodEntriesFilter.optional(),
  cursor: z
    .object({ publishedAt: z.number(), id: z.string() })
    .nullish()
    .transform((c) => (c ? { publishedAt: epochMs(c.publishedAt), id: c.id as EntryId } : null)),
})

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  const filter = parsed.success ? (parsed.data.filter ?? {}) : {}
  const cursor = parsed.success ? (parsed.data.cursor ?? null) : null
  return json(queryView(handle().db, { userId: user.id, filter, cursor }))
}
