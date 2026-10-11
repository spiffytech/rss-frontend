import type { RequestHandler } from './$types'
import { error } from '@sveltejs/kit'
import { z } from 'zod'

import { json, handle } from '../../../server/api-helpers'
import { sessionCookieOptions, SESSION_COOKIE, signSession, verifyLogin } from '../../../server/auth'

const body = z.object({ username: z.string().min(1), password: z.string().min(1) })

export const POST: RequestHandler = async ({ request, cookies }) => {
  const parsed = body.safeParse(await request.json())
  if (!parsed.success) error(400, 'invalid credentials payload')
  const user = verifyLogin(handle(), parsed.data.username, parsed.data.password)
  if (!user) error(401, 'invalid credentials')
  cookies.set(SESSION_COOKIE, signSession(user), sessionCookieOptions())
  return json({ authenticated: true, username: user.username })
}
