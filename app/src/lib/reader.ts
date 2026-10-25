/**
 * Reader state, per page render.
 *
 * Three independent reads, one small session store. Nothing here mirrors the
 * database: entries, the sidebar and prefs each have a lifecycle of their own, so
 * a page appended, an entry marked read or a panel refetch never invalidates the
 * others.
 *
 *  - `page` — a projection keyed on the URL filter. Its seed is page one;
 *    `loadMore` appends to it. Re-runs (and therefore resets) only when the
 *    filter changes, which is exactly when the list should reset.
 *  - `panelStore` — sidebar and counters, keyed on the current feed. Refreshed
 *    after writes settle, so its latency is invisible.
 *  - `prefsStore` — per-feed and per-account prefs; written on toggle.
 *  - `session` — reading anchor, expansions, scroll flags, rename editor: things
 *    no server has an opinion about, written only from client events.
 */
import {
  action,
  createEffect,
  createMemo,
  createOptimisticStore,
  createStore,
  refresh,
  snapshot,
} from 'solid-js'

import * as api from '../server/actions'
import type { EntriesFilter } from '../shared/filter'
import type { CategoryId, EntryId, EntryStatus, FeedId } from '../shared/ids'
import {
  DEFAULT_HIDE_EMPTY_FEEDS,
  DEFAULT_HIDE_READ_ITEMS,
  DEFAULT_SORT,
  DEFAULT_VIEW_MODE,
  type FeedPrefs,
  type UserPrefs,
} from '../shared/prefs'
import { shouldAutoRead } from '../shared/reading'
import type {
  EntriesResult,
  EntrySummary,
  FeedPanelResult,
  ViewCursor,
} from '../shared/types'
import { compareTitlesCI, computeUnreadCount } from '../shared/util'

/** How long after a write burst the sidebar's counters are re-read. */
const PANEL_SETTLE_MS = 300
const POLL_MS = 60_000

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
  loadingMore: boolean
  /** Pages fetched past the first window, in arrival order. */
  extra: EntrySummary[]
  /** Cursor for the next appended page (page one's cursor lives in the projection). */
  extraCursor: ViewCursor | null
  /** Read state written locally and sent to the server. */
  statusOverrides: Record<string, EntryStatus>
  /** Favorites written locally and sent to the server. */
  favoriteOverrides: Record<string, boolean>
  /** Bumped when the list is replaced, so observers can re-arm. */
  pageGen: number
}

export const createReader = (filter: () => EntriesFilter) => {
  // ---- the list ----
  /** The feed the panel should keep visible, so its own name resolves. */
  const currentFeedId = (): FeedId | null => (filter().feedId as FeedId | undefined) ?? null

  // ---- the sidebar ----
  const [panelStore, setPanelStore] = createOptimisticStore<FeedPanelResult>(
    () => api.viewPanel(currentFeedId()),
    null,
  )

  // ---- prefs ----
  const [prefsStore, setPrefsStore] = createOptimisticStore<{
    userPrefs: UserPrefs
    feedPrefs: Record<FeedId, FeedPrefs>
  }>(() => api.viewPrefs(), null)

  // ---- session ----
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
    loadingMore: false,
    extra: [],
    extraCursor: null,
    statusOverrides: {},
    favoriteOverrides: {},
    pageGen: 0,
  })

  /** Page one for the current filter. */
  const [page, setPage] = createOptimisticStore<EntriesResult & { filter: EntriesFilter }>(
    () => api.viewEntries(filter(), null),
    null,
  )

  /**
   * The list: seeded by the read, appended to as you scroll.
   *
   * The projection beside it only ever answers "page one for this filter". The
   * scrolling list is a plain store, because appended pages have to survive the
   * projection re-deriving (an optimistic projection drops writes made outside a
   * transition). One reset trigger — the filter — not "any data change".
   */


  const entries = (): EntrySummary[] => {
    const first = page.entries
    const rest = session.extra
    const all = rest.length === 0 ? first : [...first, ...rest]
    if (Object.keys(session.statusOverrides).length === 0) return all
    return all.map((entry) => {
      const status = session.statusOverrides[entry.id]
      return status && status !== entry.status ? { ...entry, status } : entry
    })
  }

  const nextCursor = (): ViewCursor | null =>
    session.extra.length > 0 ? session.extraCursor : page.nextCursor

  // A new filter means a new list: reset the reading session with it.
  createEffect(
    () => page.filter,
    () => {
      setSession((draft) => {
        draft.currentId = null
        draft.navRequest = null
        draft.userHasScrolled = false
        draft.keepUnreadIds = []
        draft.expandedIds = []
        draft.viewModeOverride = null
        draft.pageGen++
        draft.extra = []
        draft.extraCursor = null
        draft.statusOverrides = {}
        draft.favoriteOverrides = {}
        draft.loadingMore = false
      })
    },
  )

  // ---- derived ----

  const effectiveViewMode = (): 'expanded' | 'list' =>
    session.viewModeOverride ??
    (currentFeedId() ? prefsStore.feedPrefs[currentFeedId()!]?.viewMode : undefined) ??
    DEFAULT_VIEW_MODE

  const currentTitle = (): string => {
    const active = filter()
    if (active.feedId) {
      // `allFeeds` is every feed, so the name resolves even when the sidebar
      // hides it for having nothing unread.
      const feed = panelStore.allFeeds.find((candidate) => candidate.id === active.feedId)
      return feed?.title ?? 'Feed'
    }
    if (active.starred) return 'Starred'
    return 'Home'
  }

  const unreadCount = (): number | null => {
    const active = filter()
    if (!active.feedId && !active.categoryId && !active.starred && !active.search) return null
    return computeUnreadCount(active, panelStore.feeds, panelStore.counters)
  }

  const favoriteFeeds = () =>
    panelStore.allFeeds
      .filter((feed) => isFavorite(feed.id))
      .sort((a, b) => compareTitlesCI(a.title, b.title))

  const favoriteFeedsWithUnread = () =>
    favoriteFeeds().filter((feed) => (panelStore.counters[feed.id] ?? 0) > 0)

  const isFavorite = (feedId: FeedId): boolean => {
    const local = session.favoriteOverrides[feedId]
    return local ?? prefsStore.feedPrefs[feedId]?.favorite === true
  }

  // ---- read state: immediate, one call per entry ----

  /** Re-read the sidebar shortly after a burst of writes, not once per write. */
  let panelTimer: ReturnType<typeof setTimeout> | undefined
  const settlePanel = (): void => {
    clearTimeout(panelTimer)
    panelTimer = setTimeout(() => refresh(panelStore), PANEL_SETTLE_MS)
  }

  const patchStatus = (entryId: EntryId, status: EntryStatus): void => {
    setSession((draft) => {
      draft.statusOverrides[entryId] = status
    })
  }

  /** Unread count with this session's read state applied. */
  const counterFor = (feedId: FeedId): number => {
    let total = panelStore.counters[feedId] ?? 0
    for (const [entryId, status] of Object.entries(session.statusOverrides)) {
      const entry = entries().find((candidate) => candidate.id === entryId)
      if (!entry || entry.feedId !== feedId || entry.status === status) continue
      total += status === 'read' ? -1 : 1
    }
    return Math.max(0, total)
  }

  /**
   * Mark entries read (or unread): write, call, done.
   *
   * Deliberately not wrapped in `action`: these writes belong to the list store,
   * not to a transition. A failed call is corrected by re-reading page one and
   * the panel — the server replaces our answer, which is the only revert needed.
   */
  const setStatus = (entryIds: EntryId[], status: 'read' | 'unread'): void => {
    if (entryIds.length === 0) return
    for (const entryId of entryIds) patchStatus(entryId, status)
    void api
      .setStatus(entryIds, status)
      .then(() => settlePanel())
      .catch((error) => {
        console.error('marking entries failed', error)
        refresh(page)
        refresh(panelStore)
      })
  }

  const toggleRead = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = entry.status === 'read' ? 'unread' : 'read'
    setSession((draft) => {
      if (next === 'unread' && !draft.keepUnreadIds.includes(entryId)) draft.keepUnreadIds.push(entryId)
      if (next === 'read') draft.keepUnreadIds = draft.keepUnreadIds.filter((id) => id !== entryId)
    })
    setStatus([entryId], next)
  }

  const autoRead = (
    entryId: EntryId,
    viaScroll = false,
    opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
  ): void => {
    // Never auto-read during a search — scrolling results shouldn't mark matches.
    if (filter().search) return
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry || entry.status === 'read') return
    const prefs = currentFeedId() ? prefsStore.feedPrefs[currentFeedId()!] : undefined
    if (
      !shouldAutoRead({
        viewMode: session.viewModeOverride ?? prefs?.viewMode ?? DEFAULT_VIEW_MODE,
        userHasScrolled: viaScroll ? session.userHasScrolled : true,
        disabledAutoReadFeeds: (prefsStore.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
        keepUnreadIds: session.keepUnreadIds,
        feedId: entry.feedId,
        entryId,
        status: 'unread',
        ignoreFeedSetting: opts.ignoreFeedSetting,
        explicit: opts.explicit,
      })
    ) {
      return
    }
    setStatus([entryId], 'read')
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
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = !entry.starred
    action(function* () {
      // Star is server-owned; re-read page one rather than mirroring it here.
      void api.setStarred([entryId], next).then(() => refresh(page))
      yield api.setStarred([entryId], next)
    })()
  }

  // ---- pagination: append into the same list ----

  /** Scroll further: append the next window to the list. */
  const loadMore = async (): Promise<void> => {
    if (session.loadingMore) return
    setSession((draft) => {
      draft.loadingMore = true
    })
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const cursor = nextCursor()
        if (!cursor) return
        const result = await api.entries(snapshot(page.filter), snapshot(cursor))
        const seen = new Set(entries().map((entry) => entry.id))
        const fresh = result.entries.filter((entry) => !seen.has(entry.id))
        setSession((draft) => {
          if (fresh.length > 0) draft.extra.push(...snapshot(fresh))
          draft.extraCursor = result.nextCursor
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
   * End-of-list recheck: append anything beyond the loaded tail, in place.
   * Skipped for search views (their cursor can't be rebuilt from one entry) and
   * for newest-first (late arrivals belong at the top).
   */
  const checkTail = async (): Promise<void> => {
    if (nextCursor() || session.loadingMore) return
    const all = entries()
    if (all.length === 0) return
    if (page.filter.search || page.filter.sort === 'newest') return
    const tail = all[all.length - 1]!
    setSession((draft) => {
      draft.loadingMore = true
    })
    try {
      const result = await api.entries(snapshot(page.filter), {
        publishedAt: tail.publishedAt,
        id: tail.id,
      })
      const seen = new Set(entries().map((entry) => entry.id))
      const fresh = result.entries.filter((entry) => !seen.has(entry.id))
      setSession((draft) => {
        if (fresh.length > 0) draft.extra.push(...snapshot(fresh))
        draft.extraCursor = result.nextCursor
      })
    } finally {
      setSession((draft) => {
        draft.loadingMore = false
      })
    }
  }

  // ---- writes that change the view ----

  const refreshFeeds = async (): Promise<void> => {
    await api.refresh(snapshot(page.filter))
    refresh(page)
    refresh(panelStore)
  }

  const setViewMode = (viewMode: 'expanded' | 'list'): void => {
    setSession((draft) => {
      draft.viewModeOverride = viewMode
    })
    const feedId = currentFeedId()
    if (feedId) {
      void api.setPrefs(feedId, { viewMode }).then(() => refresh(prefsStore))
    }
  }

  const setSort = (sort: 'oldest' | 'newest'): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    void api.setPrefs(feedId, { sort }).then(() => {
      refresh(prefsStore)
      // The order is the server's; re-ask for page one.
      refresh(page)
    })
  }

  const setHideReadItems = (hideReadItems: boolean): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    void api.setPrefs(feedId, { hideReadItems }).then(() => {
      refresh(prefsStore)
      refresh(page)
    })
  }

  const toggleHideEmptyFeeds = async (): Promise<void> => {
    const next = !(prefsStore.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
    try {
      await api.setPrefs(null, { hideEmptyFeeds: next })
    } catch {
      return
    }
    refresh(prefsStore)
    refresh(panelStore)
  }

  const toggleAutoRead = async (feedId: FeedId): Promise<void> => {
    const list = prefsStore.userPrefs.disabledAutoReadFeeds ?? []
    const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
    try {
      await api.setPrefs(null, { disabledAutoReadFeeds: next })
    } catch {
      return
    }
    refresh(prefsStore)
  }

  const toggleFavorite = async (feedId: FeedId): Promise<void> => {
    const next = !isFavorite(feedId)
    setSession((draft) => {
      draft.favoriteOverrides[feedId] = next
    })
    try {
      await api.setPrefs(feedId, { favorite: next })
    } catch (error) {
      setSession((draft) => {
        delete draft.favoriteOverrides[feedId]
      })
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
    refresh(panelStore)
  }

  const unsubscribe = async (feedId: FeedId): Promise<void> => {
    await api.unsubscribe(feedId)
    refresh(panelStore)
    refresh(page)
  }

  const markIconFailed = (feedId: FeedId): void => {
    setSession((draft) => {
      draft.iconFailed[feedId] = true
    })
  }

  /** Re-read the sidebar (after a pref or rename that changes it). */
  const refreshPanel = (): void => {
    refresh(panelStore)
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
          refresh(panelStore)
          if (session.atListEnd) await checkTail()
        } catch (error) {
          console.error('idle refresh failed', error)
        }
      })()
    }, POLL_MS)
    return stopIdleRefresh
  }

  /** True while a read is in flight for the list (drives the dim, not a skeleton). */
  const listFilter = createMemo(() => page.filter)

  return {
    entries,
    counterFor,
    nextCursor,
    listFilter,
    filter,
    page,
    panel: panelStore,
    setPanelStore,
    prefs: prefsStore,
    setPrefsStore,
    session,
    setSession,
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
    setStatus,
    toggleStar,
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
