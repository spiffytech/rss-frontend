import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

// Old URL shape compat: /search?q=… → /?search=…
export const load: PageServerLoad = ({ url }) => {
  const q = url.searchParams.get('q') ?? ''
  redirect(302, q === '' ? '/' : `/?search=${encodeURIComponent(q)}`)
}
