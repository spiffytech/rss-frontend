// Miniflux API shapes (subset we use) + shared API response types.
// Shared between the Hono server and the Vue client (imported type-only by
// the client; erased at build).

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

export interface EntriesPage {
  entries: MinifluxEntry[]
  nextCursor?: string
  hasMore: boolean
}

// --- Per-account preferences (server SQLite store) ---

export interface UserPrefs {
  hideEmptyFeeds?: boolean
  disabledAutoReadFeeds?: number[]
}

export interface FeedPrefs {
  viewMode?: 'expanded' | 'list'
  sort?: 'oldest' | 'newest'
  hideReadItems?: boolean
}

// --- API response shapes ---

/** A single-entry mutation result. */
export interface EntryResult {
  entry: MinifluxEntry
}

/** A fresh page of entries. */
export interface EntriesResult {
  entries: MinifluxEntry[]
  nextCursor: string | null
  hasMore: boolean
}

/** Fresh sidebar data (feeds/categories/counters). */
export interface FeedPanelResult {
  feeds: MinifluxFeed[]
  categories: MinifluxCategoryCount[]
  counters: Record<string, number>
}

/** Mark-all-read: fresh counters + the reloaded page 1 (one call, no ids). */
export interface MarkAllReadResult extends EntriesResult {
  counters: Record<string, number>
}

/** Refresh: fresh panel + reloaded page 1. */
export interface RefreshResult extends EntriesResult, FeedPanelResult {}

/** Everypath the SPA needs once at page load: prefs (all feeds) + panel + page 1. */
export interface BootstrapResult extends EntriesResult, FeedPanelResult {
  userPrefs: UserPrefs
  /** All per-feed view prefs (feedId -> prefs), hydrated once. */
  feedPrefs: Record<number, FeedPrefs>
}

/** Rename result: fresh feed/category lists (titles changed). */
export interface RenameResult {
  feeds: MinifluxFeed[]
  categories: MinifluxCategoryCount[]
}

export interface SessionInfo {
  authenticated: boolean
  username?: string
}
