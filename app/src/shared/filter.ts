/**
 * The identity filter carried in the URL and over the API — ported from the
 * old app's src/shared/filter.ts, with UUIDv7 ids instead of Miniflux
 * integers and the search status toggle the plan added (the Miniflux
 * unread/read bucket split dies with the Miniflux API).
 */
import { z } from 'zod'

export const zodEntriesFilter = z.object({
  feedId: z.string().optional(),
  categoryId: z.string().optional(),
  starred: z.boolean().optional(),
  search: z.string().optional(),
  /** Search scope: both buckets (old behavior) or unread-only. */
  searchStatus: z.enum(['all', 'unread']).optional(),
  /** Presentation only (from per-feed prefs at the client): show read items. */
  hideReadItems: z.boolean().optional(),
  /** Presentation order ('oldest' default; 'newest' reverses). */
  sort: z.enum(['oldest', 'newest']).optional(),
})

export type EntriesFilter = z.infer<typeof zodEntriesFilter>

/**
 * Parse the identity filter from URL query params
 * (e.g. ?feed=<uuid>&starred=1&search=x). View prefs (view/sort/hideReadItems)
 * are NOT in the URL — they come from the per-account store during load.
 */
export function parseFilterFromUrl(query: Record<string, string | null | undefined>): EntriesFilter {
  const filter: EntriesFilter = {}
  const feed = query['feed']
  if (feed) filter.feedId = feed
  const cat = query['category']
  if (cat) filter.categoryId = cat
  if (query['starred'] === '1') filter.starred = true
  const search = query['search']
  if (search) filter.search = search
  if (query['searchStatus'] === 'unread') filter.searchStatus = 'unread'
  if (query['hideReadItems'] === '0') filter.hideReadItems = false
  if (query['hideReadItems'] === '1') filter.hideReadItems = true
  if (query['sort'] === 'oldest' || query['sort'] === 'newest') filter.sort = query['sort']
  return filter
}
