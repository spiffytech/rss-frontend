// Provider abstraction — the swap point for replacing Miniflux with an
// alternative backend. Routes are written against this interface only, so a
// future provider mounts at /api/<name> in parallel without touching the
// route layer. Auth is provider-specific (Miniflux mints per-user API keys),
// so it lives here too, as a discriminated result (no provider-specific
// error classes leak into the routes).

import type {
  EntriesPage,
  FeedCounters,
  MinifluxCategoryCount,
  MinifluxEntry,
  MinifluxFeed,
} from '../../shared/types'
import type { EntriesFilter } from '../../shared/filter'

export type AuthResult =
  | {
      ok: true
      userId: number
      username: string
      /** Provider-side session credential id (e.g. Miniflux API key id). */
      keyId: number
      /** Provider-side session credential (e.g. Miniflux API key token). */
      token: string
    }
  | { ok: false; status: number }

export interface Provider {
  /** Validate credentials and mint a session credential. */
  authenticate(username: string, password: string): Promise<AuthResult>
  /** Revoke a session credential (logout). Best-effort. */
  revokeKey(keyId: number): Promise<void>

  getFeeds(): Promise<MinifluxFeed[]>
  getCategories(): Promise<MinifluxCategoryCount[]>
  getCounters(): Promise<FeedCounters>
  getEntriesPage(filter: EntriesFilter, cursor?: string): Promise<EntriesPage>
  getEntry(entryId: number): Promise<MinifluxEntry>
  markEntries(entryIds: number[], status: 'read' | 'unread'): Promise<void>
  toggleBookmark(entryId: number): Promise<void>
  refreshFeeds(): Promise<void>
  deleteFeed(feedId: number): Promise<void>
  updateCategory(categoryId: number, title: string): Promise<void>
  updateFeed(feedId: number, title: string): Promise<void>
  getFeedIcon(feedId: number): Promise<{ mime_type: string; data: string }>
  /** Mark everything matching a filter read, server-side (no client id lists).
   *  Token-scoped: operates on the session credential's own account, no userId
   *  needed. Dispatch: feedId -> feed native mark-all, categoryId -> category
   *  native, starred/Latest -> entry-ids + bulk update, search -> iterate
   *  pages. */
  markAllReadByFilter(filter: EntriesFilter): Promise<void>
}
