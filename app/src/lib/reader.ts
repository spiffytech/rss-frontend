/**
 * Reader state, per page render.
 *
 * Two stores, split by *provenance*, which is the whole design:
 *
 *  - **`data`** is a projection (`createOptimisticStore`) over
 *    `api.bootstrap(filter)`. It is the server's answer, it is re-asked whenever
 *    we are unsure (`refresh(data)`), and it is the only place entries, the
 *    sidebar, prefs and the resolved filter come from. Because the framework
 *    owns its lifecycle it is created per render, awaits during SSR, and can
 *    never be written from inside a computation by hand.
 *  - **`session`** is a plain store of things a server has no opinion about:
 *    where you were reading, what you expanded, whether you have scrolled this
 *    list yet. Written only from client events.
 *
 * Failure policy is one line long and applies everywhere: patch optimistically,
 * call the server, and `refresh(data)` **only if the call failed** — the server
 * is the source of truth, so being wrong is corrected by re-asking, not by
 * hand-written compensating logic. A successful write is left alone, because a
 * refresh would also reset the paged window the reader is standing on.
 */
import {
  action,
  snapshot,
  createEffect,
  createMemo,
  createOptimisticStore,
  createStore,
  refresh,
} from 'solid-js'

import * as api from '../server/actions'
import type { EntriesFilter } from '../shared/filter'
import type { CategoryId, EntryId, FeedId } from '../shared/ids'
import {
  DEFAULT_HIDE_EMPTY_FEEDS,
  DEFAULT_HIDE_READ_ITEMS,
  DEFAULT_SORT,
  DEFAULT_VIEW_MODE,
  type FeedPrefs,
  type UserPrefs,
} from '../shared/prefs'
import { shouldAutoRead } from '../shared/reading'
import type { EntrySummary, FeedPanelResult, ViewCursor } from '../shared/types'
import { compareTitlesCI, computeUnreadCount } from '../shared/util'

/** Everything a server has an opinion about, for the current filter. */
export type ReaderData = FeedPanelResult & {
  entries: EntrySummary[]
  nextCursor: ViewCursor | null
  userPrefs: UserPrefs
  feedPrefs: Record<FeedId, FeedPrefs>
  /** The filter the server actually queried with (feed prefs folded in). */
  filter: EntriesFilter
}

/** Everything only this tab knows. Never crosses the wire. */
export type ReaderSession = {
  currentId: EntryId | null
  navRequest: EntryId | null
  userHasScrolled: boolean
  atListEnd: boolean
  keepUnreadIds: EntryId[]
  expandedIds: EntryId[]
  viewModeOverride: 'expanded' | 'list' | null
  iconFailed: Record<string, boolean>
  renameId: string | null
  renameKind: 'feed' | 'category' | null
  renameTitle: string
  /** Keyset cursor for the *next* window; null = end of the view. */
  cursor: ViewCursor | null
  /** Windows fetched past the server's first one, in arrival order. */
  extra: EntrySummary[]
  loadingMore: boolean
  /** Bumped when the window is replaced, so observers can re-arm. */
  pageGen: number
  /** Read state the server has been told about but has not yet echoed back. */
  statusOverrides: Record<string, 'read' | 'unread'>
}

const POLL_MS = 60_000

export const createReader = (filter: () => EntriesFilter) => {
  // ---- server truth ----
  const [data, setData] = createOptimisticStore<ReaderData>(() => api.bootstrap(filter()), null)

  // ---- client session ----
  const [session, setSession] = createStore<ReaderSession>({
    currentId: null,
    navRequest: null,
    userHasScrolled: false,
    atListEnd: false,
    keepUnreadIds: [],
    expandedIds: [],
    viewModeOverride: null,
    iconFailed: {},
    renameId: null,
    renameKind: null,
    renameTitle: '',
    cursor: null,
    extra: [],
    loadingMore: false,
    pageGen: 0,
    statusOverrides: {},
  })

  /** The visible window: the server's first page plus anything paged in. */
  const entries = createMemo<EntrySummary[]>(() => {
    const first = data.entries
    const seen = new Set(first.map((entry) => entry.id))
    const all = session.extra.length === 0 ? first : [...first, ...session.extra.filter((entry) => !seen.has(entry.id))]
    // Apply the session's read-state overlay: what you just marked read shows as
    // read immediately, without re-asking the server (and without making the
    // projection re-derive, which would blank the list).
    return all.map((entry) => {
      const override = session.statusOverrides[entry.id]
      return override && override !== entry.status ? { ...entry, status: override } : entry
    })
  })

  const nextCursor = () => session.cursor ?? data.nextCursor

  // A new answer from the server replaces the window: drop the pages we appended
  // and start paging again from its cursor. Runs for a navigation *and* for a
  // refresh after a write, which is what "server wins" means.
  createEffect(
    () => [data.filter, data.entries] as const,
    () => {
      setSession((draft) => {
        draft.statusOverrides = {}
        draft.extra = []
        draft.cursor = null
        draft.currentId = null
        draft.navRequest = null
        draft.userHasScrolled = false
        draft.keepUnreadIds = []
        draft.expandedIds = []
        draft.viewModeOverride = null
        draft.pageGen++
      })
    },
  )

  // ---- derived ----

  const currentFeedId = (): FeedId | null => (filter().feedId as FeedId | undefined) ?? null

  const effectiveViewMode = (): 'expanded' | 'list' =>
    session.viewModeOverride ??
    (currentFeedId() ? data.feedPrefs[currentFeedId()!]?.viewMode : undefined) ??
    DEFAULT_VIEW_MODE

  const currentTitle = (): string => {
    const active = filter()
    if (active.feedId) {
      // The sidebar hides feeds with nothing unread; the projection carries the
      // whole catalog (`allFeeds`), so the name is always available — no cache,
      // no `Feed <uuid>` fallback.
      const feed = data.allFeeds.find((candidate) => candidate.id === active.feedId)
      return feed?.title ?? 'Feed'
    }
    if (active.starred) return 'Starred'
    return 'Home'
  }

  const unreadCount = (): number | null => {
    const active = filter()
    if (!active.feedId && !active.categoryId && !active.starred && !active.search) return null
    return computeUnreadCount(active, data.feeds, data.counters)
  }

  const favoriteFeeds = () =>
    data.allFeeds
      .filter((feed) => data.feedPrefs[feed.id]?.favorite === true)
      .sort((a, b) => compareTitlesCI(a.title, b.title))

  const favoriteFeedsWithUnread = () =>
    favoriteFeeds().filter((feed) => (data.counters[feed.id] ?? 0) > 0)

  const isFavorite = (feedId: FeedId): boolean => data.feedPrefs[feedId]?.favorite === true

  // ---- read state: local, batched, corrected by the server ----

  /** Patch read state for an entry wherever it lives: window, page or overlay. */
  const patchStatus = (entryId: EntryId, status: 'read' | 'unread'): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry || entry.status === status) return
    setSession((draft) => {
      draft.statusOverrides[entryId] = status
    })
  }

  /** Unread count with this session's pending read-state applied. */
  const counterFor = (feedId: FeedId): number => {
    const base = data.counters[feedId] ?? 0
    let delta = 0
    for (const [entryId, status] of Object.entries(session.statusOverrides)) {
      const entry =
        data.entries.find((candidate) => candidate.id === entryId) ??
        session.extra.find((candidate) => candidate.id === entryId)
      if (!entry || entry.feedId !== feedId) continue
      if (entry.status === status) continue
      delta += status === 'read' ? -1 : 1
    }
    return Math.max(0, base + delta)
  }

  /**
   * Set read state: one optimistic write, one server call, in one transition.
   *
   * The write and the call must live in the same action — that is what makes a
   * failure revert by itself, with no compensating logic here.
   */
  const setStatus = (entryIds: EntryId[], status: 'read' | 'unread'): void => {
    if (entryIds.length === 0) return
    action(function* () {
      for (const entryId of entryIds) patchStatus(entryId, status)
      yield api.setStatus(entryIds, status)
    })()
  }

  const setLocalStatus = (entryId: EntryId, status: 'read' | 'unread'): void => {
    setStatus([entryId], status)
  }

  const toggleRead = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = entry.status === 'read' ? 'unread' : 'read'
    setSession((draft) => {
      if (next === 'unread' && !draft.keepUnreadIds.includes(entryId)) draft.keepUnreadIds.push(entryId)
      if (next === 'read') draft.keepUnreadIds = draft.keepUnreadIds.filter((id) => id !== entryId)
    })
    setLocalStatus(entryId, next)
  }

  const autoRead = (
    entryId: EntryId,
    viaScroll = false,
    opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
  ): void => {
    // Never auto-read during a search — scrolling results shouldn't mark matches.
    if (filter().search) return
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const prefs = currentFeedId() ? data.feedPrefs[currentFeedId()!] : undefined
    if (
      !shouldAutoRead({
        viewMode: session.viewModeOverride ?? prefs?.viewMode ?? DEFAULT_VIEW_MODE,
        userHasScrolled: viaScroll ? session.userHasScrolled : true,
        disabledAutoReadFeeds: (data.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
        keepUnreadIds: session.keepUnreadIds,
        feedId: entry.feedId,
        entryId,
        status: entry.status === 'read' ? 'read' : 'unread',
        ignoreFeedSetting: opts.ignoreFeedSetting,
        explicit: opts.explicit,
      })
    ) {
      return
    }
    setLocalStatus(entryId, 'read')
  }

  const toggleExpanded = (entryId: EntryId): void => {
    if (session.expandedIds.includes(entryId)) {
      setSession((draft) => {
        draft.expandedIds = draft.expandedIds.filter((id) => id !== entryId)
      })
      return
    }
    setSession((draft) => {
      draft.expandedIds.push(entryId)
    })
    autoRead(entryId, false, { ignoreFeedSetting: true, explicit: true })
  }

  const moveAndRead = (delta: 1 | -1): void => {
    const ids = entries().map((entry) => entry.id)
    if (ids.length === 0) return
    const currentIndex = session.currentId ? ids.indexOf(session.currentId) : -1
    const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + delta))
    const nextId = ids[nextIndex]!
    setSession((draft) => {
      draft.currentId = nextId
      draft.navRequest = nextId
    })
    autoRead(nextId)
  }

  const markDisplayed = (): void => {
    const unread = entries().filter((entry) => entry.status !== 'read').map((entry) => entry.id)
    setStatus(unread, 'read')
  }

  const toggleStar = (entryId: EntryId): void => {
    action(function* () {
      const entry = entries().find((candidate) => candidate.id === entryId)
      if (!entry) return
      const next = !entry.starred
      setData((draft) => {
        const target = draft.entries.find((candidate) => candidate.id === entryId)
        if (target) target.starred = next
      })
      setSession((draft) => {
        const target = draft.extra.find((candidate) => candidate.id === entryId)
        if (target) target.starred = next
      })
      yield api.setStarred([entryId], next)
      // No refresh on success: it would reset the window the reader is standing
      // on. A throw above reverts the optimistic write on its own.
    })()
  }

  // ---- pagination ----

  const loadMore = async (): Promise<void> => {
    if (session.loadingMore) return
    setSession((draft) => {
      draft.loadingMore = true
    })
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const cursor = nextCursor()
        if (!cursor) return
        const result = await api.entries(snapshot(data.filter), cursor)
        const seen = new Set(entries().map((entry) => entry.id))
        const fresh = result.entries.filter((entry) => !seen.has(entry.id))
        setSession((draft) => {
          if (fresh.length > 0) draft.extra.push(...fresh)
          draft.cursor = result.nextCursor
        })
        if (fresh.length > 0 || !result.nextCursor) return
      }
    } finally {
      setSession((draft) => {
        draft.loadingMore = false
      })
    }
  }

  /**
   * End-of-list recheck: ask for anything beyond the loaded tail and append it in
   * place. Skipped for search views (their cursor can't be rebuilt from one
   * entry) and for newest-first (late arrivals belong at the top).
   */
  const checkTail = async (): Promise<void> => {
    if (nextCursor() || session.loadingMore) return
    const all = entries()
    if (all.length === 0) return
    if (data.filter.search || data.filter.sort === 'newest') return
    const tail = all[all.length - 1]!
    setSession((draft) => {
      draft.loadingMore = true
    })
    try {
      const result = await api.entries(snapshot(data.filter), {
        publishedAt: tail.publishedAt,
        id: tail.id,
      })
      const seen = new Set(entries().map((entry) => entry.id))
      const fresh = result.entries.filter((entry) => !seen.has(entry.id))
      setSession((draft) => {
        if (fresh.length > 0) draft.extra.push(...fresh)
        draft.cursor = result.nextCursor
      })
    } finally {
      setSession((draft) => {
        draft.loadingMore = false
      })
    }
  }

  // ---- writes that change the view ----

  const refreshFeeds = async (): Promise<void> => {
    await api.refresh(snapshot(data.filter))
    refresh(data)
  }

  const setViewMode = (viewMode: 'expanded' | 'list'): void => {
    setSession((draft) => {
      draft.viewModeOverride = viewMode
    })
    const feedId = currentFeedId()
    if (feedId) {
      setData((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], viewMode }
      })
      void api.setPrefs(feedId, { viewMode }).catch(() => refresh(data))
    }
  }

  const setSort = (sort: 'oldest' | 'newest'): void => {
    const feedId = currentFeedId()
    if (feedId) {
      setData((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], sort }
      })
    }
    void api.setPrefs(feedId, { sort }).catch(() => refresh(data))
    // The order is the server's business.
    refresh(data)
  }

  const setHideReadItems = (hideReadItems: boolean): void => {
    const feedId = currentFeedId()
    if (feedId) {
      setData((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], hideReadItems }
      })
    }
    void api.setPrefs(feedId, { hideReadItems }).catch(() => refresh(data))
    refresh(data)
  }

  const toggleHideEmptyFeeds = async (): Promise<void> => {
    const next = !(data.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
    try {
      await api.setPrefs(null, { hideEmptyFeeds: next })
    } catch {
      return
    }
    refresh(data)
  }

  const toggleAutoRead = async (feedId: FeedId): Promise<void> => {
    const list = data.userPrefs.disabledAutoReadFeeds ?? []
    const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
    try {
      await api.setPrefs(null, { disabledAutoReadFeeds: next })
    } catch {
      return
    }
    setData((draft) => {
      draft.userPrefs = { ...draft.userPrefs, disabledAutoReadFeeds: next }
    })
  }

  const toggleFavorite = async (feedId: FeedId): Promise<void> => {
    const next = !isFavorite(feedId)
    setData((draft) => {
      draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], favorite: next }
    })
    try {
      await api.setPrefs(feedId, { favorite: next })
    } catch (error) {
      refresh(data)
      throw error
    }
  }

  const startRename = (id: string, kind: 'feed' | 'category', title: string): void => {
    setSession((draft) => {
      draft.renameId = id
      draft.renameKind = kind
      draft.renameTitle = title
    })
  }

  const cancelRename = (): void => {
    setSession((draft) => {
      draft.renameId = null
      draft.renameKind = null
      draft.renameTitle = ''
    })
  }

  const saveRename = async (): Promise<void> => {
    const id = session.renameId
    const kind = session.renameKind
    const title = session.renameTitle.trim()
    if (id == null || kind == null || !title) return
    if (kind === 'feed') await api.renameFeed(id as FeedId, title)
    else await api.renameCategory(id as CategoryId, title)
    cancelRename()
    refresh(data)
  }

  const unsubscribe = async (feedId: FeedId): Promise<void> => {
    await api.unsubscribe(feedId)
    refresh(data)
  }

  const markIconFailed = (feedId: FeedId): void => {
    setSession((draft) => {
      draft.iconFailed[feedId] = true
    })
  }

  /** Sidebar + favorites, refreshed in place when a pref or rename changes it. */
  const refreshPanel = (): void => {
    refresh(data)
  }

  // ---- idle refresh: keep the sidebar honest while the page sits open ----

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const stopIdleRefresh = (): void => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }

  const startIdleRefresh = (): (() => void) => {
    if (pollTimer) return stopIdleRefresh
    pollTimer = setInterval(() => {
      void (async () => {
        try {
          refresh(data)
          if (session.atListEnd) await checkTail()
        } catch (error) {
          console.error('idle refresh failed', error)
        }
      })()
    }, POLL_MS)
    return stopIdleRefresh
  }

  return {
    data,
    setData,
    session,
    setSession,
    entries,
    counterFor,
    nextCursor,
    currentTitle,
    unreadCount,
    effectiveViewMode,
    favoriteFeeds,
    favoriteFeedsWithUnread,
    isFavorite,
    toggleFavorite,
    toggleRead,
    toggleExpanded,
    autoRead,
    moveAndRead,
    markDisplayed,
    toggleStar,
    setStatus,
    loadMore,
    checkTail,
    refreshFeeds,
    refreshPanel,
    setViewMode,
    setSort,
    setHideReadItems,
    toggleHideEmptyFeeds,
    toggleAutoRead,
    startRename,
    cancelRename,
    saveRename,
    unsubscribe,
    markIconFailed,
    startIdleRefresh,
  }
}

export type Reader = ReturnType<typeof createReader>
