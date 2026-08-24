import { z } from 'zod'

export const zodEntriesFilter = z.object({
  feedId: z.number().int().positive().optional().or(z.literal('')),
  categoryId: z.number().int().positive().optional().or(z.literal('')),
  status: z.enum(['unread']).default('unread'),
  starred: z.boolean().optional(),
  search: z.string().optional(),
  hideReadItems: z.boolean().optional(),
  /** Per-feed presentation order ('oldest' default; 'newest' reverses). */
  sort: z.enum(['oldest', 'newest']).optional(),
})

export type EntriesFilter = z.infer<typeof zodEntriesFilter>

/**
 * Parse the identity filter from URL query params (e.g. ?feed=155&starred=1&search=x).
 * View prefs (view/sort/hideReadItems) are NOT in the URL — they come from the
 * per-account store during load.
 */
export function parseFilterFromUrl(
  query: Record<string, string | null | undefined>,
): EntriesFilter {
  const filter: EntriesFilter = { status: 'unread' }
  const feed = Number(query['feed'])
  if (Number.isInteger(feed) && feed > 0) filter.feedId = feed
  const cat = Number(query['category'])
  if (Number.isInteger(cat) && cat > 0) filter.categoryId = cat
  if (query['starred'] === '1') filter.starred = true
  const search = query['search']
  if (search) filter.search = search
  return filter
}
