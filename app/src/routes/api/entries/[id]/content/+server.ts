import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'

import type { EntryId } from '../../../../../shared/ids'
import { json, handle, requireUser } from '../../../../../server/api-helpers'
import { getEntryContent } from '../../../../../server/query/views'

export const GET: RequestHandler = ({ params, locals }) => {
  const user = requireUser(locals)
  const content = getEntryContent(handle().db, { userId: user.id, entryId: params.id as EntryId })
  if (!content) error(404, 'entry not found')
  return json(content)
}
