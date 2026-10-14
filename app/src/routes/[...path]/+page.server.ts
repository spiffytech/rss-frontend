import { redirect } from '@sveltejs/kit'
import type { PageServerLoad } from './$types'

/** Old SPA catch-all: unknown URLs bounce to the reader root. */
export const load: PageServerLoad = async () => {
  redirect(307, '/')
}
