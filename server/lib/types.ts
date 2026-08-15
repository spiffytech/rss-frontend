import { z } from 'zod'

// --- Miniflux API shapes (subset we use) ---

export interface MinifluxCategory {
  id: number
  user_id: number
  title: string
}

export interface MinifluxFeed {
  id: number
  user_id: number
  title: string
  site_url: string
  feed_url: string
  category: MinifluxCategory | null
  icon?: { feed_id: number; icon_id: number } | null
}

export interface MinifluxEntry {
  id: number
  user_id: number
  feed_id: number
  title: string
  url: string
  author: string
  content: string
  published_at: string
  status: 'read' | 'unread'
  starred: boolean
  reading_time: number
  feed?: MinifluxFeed | null
}

export interface MinifluxCategoryCount {
  id: number
  title: string
  total_unread: number
  feed_count: number
}

export interface FeedCounters {
  reads: Record<string, number>
  unreads: Record<string, number>
}

// --- Filter described by client signals ---

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

/** Result of a cursor-paginated entry fetch. */
export interface EntriesPage {
  entries: MinifluxEntry[]
  /** ISO timestamp of the last entry — pass as cursor for the next page. */
  nextCursor?: string
  hasMore: boolean
}
export type EntriesFilter = z.infer<typeof zodEntriesFilter>