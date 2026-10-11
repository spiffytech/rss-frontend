import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

import type { CategoryId } from '../../../../../shared/ids'
import { json, handle, requireUser } from '../../../../../server/api-helpers'
import { categories } from '../../../../../server/db/schema'

const body = z.object({ title: z.string().min(1).max(500) })

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  const user = requireUser(locals)
  const parsed = body.safeParse(await request.json())
  if (!parsed.success) error(400, 'invalid title')
  const db = handle()
  const changed = db.db
    .update(categories)
    .set({ title: parsed.data.title })
    .where(and(eq(categories.id, params.id as CategoryId), eq(categories.userId, user.id)))
    .returning({ id: categories.id })
    .all()
  if (changed.length === 0) error(404, 'category not found')
  return json({ ok: true })
}
