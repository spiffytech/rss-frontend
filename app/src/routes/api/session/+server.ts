import type { RequestHandler } from './$types'
import { json } from '../../../server/api-helpers'

export const GET: RequestHandler = ({ locals }) => {
  return json(locals.user ? { authenticated: true, username: locals.user.username } : { authenticated: false })
}
