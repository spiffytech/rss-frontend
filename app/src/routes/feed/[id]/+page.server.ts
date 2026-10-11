import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'

// Old URL shape compat: /feed/<uuid> → /?feed=<uuid>
export const load: PageServerLoad = ({ params }) => {
  redirect(302, `/?feed=${params.id}`)
}
