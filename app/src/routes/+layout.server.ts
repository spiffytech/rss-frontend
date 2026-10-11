import type { LayoutServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

export const load: LayoutServerLoad = ({ locals, url }) => {
  const isLogin = url.pathname === '/login'
  if (!locals.user && !isLogin) redirect(303, '/login')
  if (locals.user && isLogin) redirect(303, '/')
  return { user: locals.user }
}
