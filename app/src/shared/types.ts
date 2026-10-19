/**
 * API shapes shared by the SvelteKit server and the client. Ported from the
 * old app's src/shared/types.ts: Miniflux's pagination fields die (one full
 * display set per view), and entry bodies leave the list payload (content
 * loads per card).
 */
import type { EntriesFilter } from './filter'
import type { CategoryId, EntryId, EntryStatus, EpochMs, FeedId } from './ids'
import type { FeedPrefs, UserPrefs } from './prefs'

/** The list row: everything the view renders except the entry body. */
export type EntrySummary = {
  id: EntryId
  feedId: FeedId
  feedTitle: string
  title: string
  url: string | null
  author: string | null
  publishedAt: EpochMs
  status: EntryStatus
  starred: boolean
  readingTime: number
  tags: string[]
}

/** Per-card fetch: the raw HTML body (display pipeline runs client-side). */
export type EntryContent = {
  id: EntryId
  content: string
  commentsUrl: string | null
  language: string | null
  /** Feed base URL for resolving relative links inside the body. */
  feedBaseUrl: string | null
}

export type CategoryCount = {
  id: CategoryId
  title: string
  totalUnread: number
  feedCount: number
}

export type FeedInfo = {
  id: FeedId
  categoryId: CategoryId
  title: string
  siteUrl: string | null
  feedUrl: string
  disabled: boolean
  parsingErrorCount: number
  iconUrl: string | null
}

export type FeedPanelResult = {
  feeds: FeedInfo[]
  categories: CategoryCount[]
  /** Unread counts per feed — same filter predicate as the lists. */
  counters: Record<FeedId, number>
}

export type EntriesResult = {
  entries: EntrySummary[]
  /** Keyset cursor into (published_at, id); null = end of the view. */
  nextCursor: ViewCursor | null
}

/** Keyset cursor into (published_at, id). `bucket` is present only for
 *  search views, whose ordering is unread-first (0 = unread, 1 = read). */
export type ViewCursor = { publishedAt: EpochMs; id: EntryId; bucket?: 0 | 1 }

export type EntryResult = {
  entry: EntrySummary
}

/** Everything the SPA needs once at page load. */
export interface BootstrapResult extends EntriesResult, FeedPanelResult {
  userPrefs: UserPrefs
  /** All per-feed view prefs (feedId -> prefs), hydrated once. */
  feedPrefs: Record<FeedId, FeedPrefs>
  /** The submitted identity filter with this feed's view prefs folded in —
   *  exactly the filter the returned entries were queried with. */
  filter: EntriesFilter
}

export type SessionInfo = {
  authenticated: boolean
  username?: string
}
