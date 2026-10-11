import type { RequestHandler } from './$types'
import { json } from '../../../server/api-helpers'
import { SESSION_COOKIE } from '../../../server/auth'

export const POST: RequestHandler = ({ cookies }) => {
  cookies.delete(SESSION_COOKIE, { path: '/' })
  return json({ authenticated: false })
}
