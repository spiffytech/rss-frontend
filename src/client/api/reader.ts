// Provider-agnostic reader API client. The SPA talks through this interface
// only; `createMinifluxReaderApi()` backs it with Hono RPC (hc<AppType>).
// A future provider = a new factory + base path, no store/component changes.

import { hc } from 'hono/client'
import type { AppType } from '@/server/app'
import type {
  BootstrapResult,
  EntryResult,
  EntriesResult,
  FeedPanelResult,
  MarkAllReadResult,
  RefreshResult,
  RenameResult,
  SessionInfo,
} from '@/shared/types'
import type { EntriesFilter } from '@/shared/filter'

export interface ReaderApi {
  session(): Promise<SessionInfo>
  login(username: string, password: string): Promise<void>
  logout(): Promise<void>

  bootstrap(filter: EntriesFilter): Promise<BootstrapResult>
  entries(filter: EntriesFilter, cursor?: string): Promise<EntriesResult>
  counters(): Promise<Record<string, number>>
  /** Lean sidebar snapshot (feeds + categories + unreads) for idle polling. */
  panel(): Promise<FeedPanelResult>

  toggleRead(id: number): Promise<EntryResult>
  star(id: number): Promise<EntryResult>

  /** Persist a batched read/unread status change (204). The client applies the
   *  change optimistically and sends accumulated ids on a short debounce. */
  setStatus(entryIds: number[], status: 'read' | 'unread'): Promise<void>

  markAllRead(filter?: EntriesFilter): Promise<MarkAllReadResult>
  refresh(filter?: EntriesFilter): Promise<RefreshResult>

  unsubscribe(feedId: number): Promise<void>
  renameFeed(feedId: number, title: string): Promise<RenameResult>
  renameCategory(categoryId: number, title: string): Promise<RenameResult>

  setViewMode(feedId: number | undefined, viewMode: 'expanded' | 'list'): Promise<void>
  setSort(feedId: number | undefined, sort: 'oldest' | 'newest'): Promise<void>
  setHideReadItems(feedId: number | undefined, hideReadItems: boolean): Promise<void>
  setHideEmptyFeeds(hideEmptyFeeds: boolean): Promise<void>
  setAutoRead(disabledAutoReadFeeds: number[]): Promise<void>
}

export function createMinifluxReaderApi(): ReaderApi {
  const client = hc<AppType>('/')
  const api = client.api.miniflux

  // Hono's RPC client returns ClientResponse (not the DOM Response); this
  // minimal structural type keeps unwrap() working for both.
  interface ApiResponse {
    ok: boolean
    status: number
    statusText: string
    json(): Promise<unknown>
  }

  async function unwrap<T>(res: ApiResponse): Promise<T> {
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${res.statusText}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async session() {
      return unwrap<SessionInfo>(await api.session.$get())
    },
    async login(username, password) {
      const res = await api.login.$post({ json: { username, password } })
      if (!res.ok) throw new Error(`login failed: ${res.status}`)
    },
    async logout() {
      const res = await api.logout.$post()
      if (!res.ok) throw new Error(`logout failed: ${res.status}`)
    },

    async bootstrap(filter) {
      return unwrap<BootstrapResult>(await api.bootstrap.$post({ json: { filter } }))
    },
    async entries(filter, cursor) {
      return unwrap<EntriesResult>(await api.entries.$post({ json: { filter, cursor } }))
    },
    async counters() {
      return unwrap<Record<string, number>>(await api.counters.$get())
    },

    async panel() {
      return unwrap<FeedPanelResult>(await api.panel.$get())
    },

    async toggleRead(id) {
      return unwrap<EntryResult>(
        await api.entries[':id'].toggleRead.$post({ param: { id: String(id) } }),
      )
    },
    async star(id) {
      return unwrap<EntryResult>(
        await api.entries[':id'].star.$post({ param: { id: String(id) } }),
      )
    },
    async setStatus(entryIds, status) {
      const res = await api.entries.status.$post({ json: { entryIds, status } })
      if (!res.ok) throw new Error(`setStatus failed: ${res.status}`)
    },

    async markAllRead(filter) {
      return unwrap<MarkAllReadResult>(await api.markAllRead.$post({ json: { filter } }))
    },
    async refresh(filter) {
      return unwrap<RefreshResult>(await api.refresh.$post({ json: { filter } }))
    },

    async unsubscribe(feedId) {
      const res = await api.feeds[':id'].unsubscribe.$post({ param: { id: String(feedId) } })
      if (!res.ok) throw new Error(`unsubscribe failed: ${res.status}`)
    },
    async renameFeed(feedId, title) {
      return unwrap<RenameResult>(
        await api.feeds[':id'].rename.$put({ param: { id: String(feedId) }, json: { title } }),
      )
    },
    async renameCategory(categoryId, title) {
      return unwrap<RenameResult>(
        await api.categories[':id'].rename.$put({ param: { id: String(categoryId) }, json: { title } }),
      )
    },

    async setViewMode(feedId, viewMode) {
      const res = await api.prefs.viewMode.$put({ json: { feedId, viewMode } })
      if (!res.ok) throw new Error(`viewMode failed: ${res.status}`)
    },
    async setSort(feedId, sort) {
      const res = await api.prefs.sort.$put({ json: { feedId, sort } })
      if (!res.ok) throw new Error(`sort failed: ${res.status}`)
    },
    async setHideReadItems(feedId, hideReadItems) {
      const res = await api.prefs.hideReadItems.$put({ json: { feedId, hideReadItems } })
      if (!res.ok) throw new Error(`hideReadItems failed: ${res.status}`)
    },
    async setHideEmptyFeeds(hideEmptyFeeds) {
      const res = await api.prefs.hideEmptyFeeds.$put({ json: { hideEmptyFeeds } })
      if (!res.ok) throw new Error(`hideEmptyFeeds failed: ${res.status}`)
    },
    async setAutoRead(disabledAutoReadFeeds) {
      const res = await api.prefs.autoRead.$put({ json: { disabledAutoReadFeeds } })
      if (!res.ok) throw new Error(`autoRead failed: ${res.status}`)
    },
  }
}
