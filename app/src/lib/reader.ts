/**
 * Reader state, per page render.
 *
 * Server data lives in optimistic projections; mutation goes through `action`
 * (write optimistically, `yield` the call, `refresh` the projection); what no
 * server has an opinion about lives in a plain session store.
 *
 * Two shapes are driven by the projection's semantics:
 *
 *  - **Paging grows the window** (`windowSize`). `refresh` replaces a
 *    projection's value, so a cursor-append would be thrown away; asking again
 *    with a bigger `LIMIT` returns the same rows plus more.
 *  - **Rows you read stay put**, via `keepIds` in the filter: the query keeps the
 *    rows this session marked read (`status = 'unread' OR id IN (…)`), so the
 *    refresh after a write does not make them vanish mid-scroll. They leave when
 *    you navigate, because the session ends.
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

/** The RPC boundary takes JSON: hand it plain data, never a store proxy. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
import type { EntriesResult, EntrySummary, FeedPanelResult } from '../shared/types'
import { compareTitlesCI, computeUnreadCount } from '../shared/util'

/** One screenful; scrolling asks for another. */
const PAGE_SIZE = 100
/** How many ids the query keeps for rows read in this session. */
const KEEP_LIMIT = 500
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
  /** Rows to ask for; grows as you scroll. */
  windowSize: number
  /** Rows this session has read, kept in the window by the query. */
  keepIds: EntryId[]
  /** Bumped when the list is replaced, so observers can re-arm. */
  pageGen: number
}

const identity = (filter: EntriesFilter): string =>
  [filter.feedId ?? '', filter.categoryId ?? '', filter.starred ? '1' : '', filter.search ?? ''].join(
    '|',
  )

export const createReader = (filter: () => EntriesFilter) => {
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
    windowSize: PAGE_SIZE,
    keepIds: [],
    pageGen: 0,
  })

  const currentFeedId = (): FeedId | null => (filter().feedId as FeedId | undefined) ?? null

  /** The URL's view plus this session's window and retained rows. */
  const queryFilter = createMemo<EntriesFilter>(() => ({
    ...filter(),
    keepIds: session.keepIds.length > 0 ? [...session.keepIds] : undefined,
  }))

  // ---- server data ----
  const [page, setPage] = createOptimisticStore<EntriesResult & { filter: EntriesFilter }>(
    () => api.viewEntries(wire(queryFilter()), null, session.windowSize),
    null,
  )
  const [panel, setPanel] = createOptimisticStore<FeedPanelResult>(
    () => api.viewPanel(currentFeedId()),
    null,
  )
  const [prefs, setPrefs] = createOptimisticStore<{
    userPrefs: UserPrefs
    feedPrefs: Record<FeedId, FeedPrefs>
  }>(() => api.viewPrefs(), null)

  const entries = (): EntrySummary[] => page.entries

  // ---- derived ----

  const effectiveViewMode = (): 'expanded' | 'list' =>
    session.viewModeOverride ??
    (currentFeedId() ? prefs.feedPrefs[currentFeedId()!]?.viewMode : undefined) ??
    DEFAULT_VIEW_MODE

  const currentTitle = (): string => {
    const active = filter()
    if (active.feedId) {
      const feed = panel.allFeeds.find((candidate) => candidate.id === active.feedId)
      return feed?.title ?? 'Feed'
    }
    if (active.starred) return 'Starred'
    return 'Home'
  }

  const unreadCount = (): number | null => {
    const active = filter()
    if (!active.feedId && !active.categoryId && !active.starred && !active.search) return null
    return computeUnreadCount(active, panel.feeds, panel.counters)
  }

  const favoriteFeeds = () =>
    panel.allFeeds
      .filter((feed) => prefs.feedPrefs[feed.id]?.favorite === true)
      .sort((a, b) => compareTitlesCI(a.title, b.title))

  const favoriteFeedsWithUnread = () =>
    favoriteFeeds().filter((feed) => (panel.counters[feed.id] ?? 0) > 0)

  const isFavorite = (feedId: FeedId): boolean => prefs.feedPrefs[feedId]?.favorite === true

  // ---- writes ----

  /** Sidebar counters follow writes, a beat later rather than per write. */
  let panelTimer: ReturnType<typeof setTimeout> | undefined
  const settlePanel = (): void => {
    clearTimeout(panelTimer)
    panelTimer = setTimeout(() => refresh(panel), PANEL_SETTLE_MS)
  }

  /**
   * Mark entries read (or unread): optimistic, then the server's answer.
   *
   * The ids join `keepIds` first, so the refresh still returns the rows the write
   * just made non-matching — a row must not disappear from under the reader.
   */
  const setStatus = (entryIds: EntryId[], status: 'read' | 'unread'): void => {
    if (entryIds.length === 0) return
    if (status === 'read') {
      setSession((draft) => {
        const merged = [...draft.keepIds]
        for (const id of entryIds) if (!merged.includes(id)) merged.push(id)
        draft.keepIds = merged.slice(-KEEP_LIMIT)
      })
    }
    action(function* () {
      setPage((draft) => {
        for (const entryId of entryIds) {
          const entry = draft.entries.find((candidate) => candidate.id === entryId)
          if (entry) entry.status = status
        }
      })
      yield api.setStatus(entryIds, status)
      refresh(page)
      settlePanel()
    })()
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
    const feedPrefs = currentFeedId() ? prefs.feedPrefs[currentFeedId()!] : undefined
    if (
      !shouldAutoRead({
        viewMode: session.viewModeOverride ?? feedPrefs?.viewMode ?? DEFAULT_VIEW_MODE,
        userHasScrolled: viaScroll ? session.userHasScrolled : true,
        disabledAutoReadFeeds: (prefs.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
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
    const unread = entries()
      .filter((entry) => entry.status !== 'read')
      .map((entry) => entry.id)
    setStatus(unread, 'read')
  }

  const toggleStar = (entryId: EntryId): void => {
    const entry = entries().find((candidate) => candidate.id === entryId)
    if (!entry) return
    const next = !entry.starred
    action(function* () {
      setPage((draft) => {
        const target = draft.entries.find((candidate) => candidate.id === entryId)
        if (target) target.starred = next
      })
      yield api.setStarred([entryId], next)
      refresh(page)
    })()
  }

  // ---- paging: a bigger window ----

  const loadMore = (): void => {
    if (!page.nextCursor) return
    setSession((draft) => {
      draft.windowSize += PAGE_SIZE
    })
  }

  const checkTail = (): void => {
    if (session.atListEnd) loadMore()
  }

  // A new view means a new list. Keyed on the URL filter (a string), not on the
  // projection's value: that would re-fire on every read and loop, because the
  // reset writes the projection's own inputs.
  const viewKey = createMemo(() => identity(filter()))
  createEffect(viewKey, () => {
    setSession((draft) => {
      draft.currentId = null
      draft.navRequest = null
      draft.userHasScrolled = false
      draft.keepUnreadIds = []
      draft.expandedIds = []
      draft.viewModeOverride = null
      draft.windowSize = PAGE_SIZE
      draft.keepIds = []
      draft.pageGen++
    })
  })

  // ---- writes that change the view ----

  const refreshFeeds = async (): Promise<void> => {
    await api.refresh(snapshot(queryFilter()))
    refresh(page)
    refresh(panel)
  }

  const setViewMode = (viewMode: 'expanded' | 'list'): void => {
    setSession((draft) => {
      draft.viewModeOverride = viewMode
    })
    const feedId = currentFeedId()
    if (!feedId) return
    action(function* () {
      setPrefs((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], viewMode }
      })
      yield api.setPrefs(feedId, { viewMode })
      refresh(prefs)
    })()
  }

  const setSort = (sort: 'oldest' | 'newest'): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    action(function* () {
      setPrefs((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], sort }
      })
      yield api.setPrefs(feedId, { sort })
      refresh(prefs)
      refresh(page)
    })()
  }

  const setHideReadItems = (hideReadItems: boolean): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    action(function* () {
      setPrefs((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], hideReadItems }
      })
      yield api.setPrefs(feedId, { hideReadItems })
      refresh(prefs)
      refresh(page)
    })()
  }

  const toggleHideEmptyFeeds = (): void => {
    const next = !(prefs.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
    action(function* () {
      setPrefs((draft) => {
        draft.userPrefs = { ...draft.userPrefs, hideEmptyFeeds: next }
      })
      yield api.setPrefs(null, { hideEmptyFeeds: next })
      refresh(prefs)
      refresh(panel)
    })()
  }

  const toggleAutoRead = (feedId: FeedId): void => {
    const list = prefs.userPrefs.disabledAutoReadFeeds ?? []
    const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
    action(function* () {
      setPrefs((draft) => {
        draft.userPrefs = { ...draft.userPrefs, disabledAutoReadFeeds: next }
      })
      yield api.setPrefs(null, { disabledAutoReadFeeds: next })
      refresh(prefs)
    })()
  }

  const toggleFavorite = (feedId: FeedId): void => {
    const next = !isFavorite(feedId)
    action(function* () {
      setPrefs((draft) => {
        draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], favorite: next }
      })
      yield api.setPrefs(feedId, { favorite: next })
      refresh(prefs)
    })()
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
    refresh(panel)
  }

  const unsubscribe = async (feedId: FeedId): Promise<void> => {
    await api.unsubscribe(feedId)
    refresh(panel)
    refresh(page)
  }

  const markIconFailed = (feedId: FeedId): void => {
    setSession((draft) => {
      draft.iconFailed[feedId] = true
    })
  }

  const refreshPanel = (): void => {
    refresh(panel)
  }

  // ---- idle refresh ----

  let pollTimer: ReturnType<typeof setInterval> | undefined

  const stopIdleRefresh = (): void => {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = undefined
  }

  const startIdleRefresh = (): (() => void) => {
    if (pollTimer) return stopIdleRefresh
    pollTimer = setInterval(() => {
      refresh(panel)
      if (session.atListEnd) refresh(page)
    }, POLL_MS)
    return stopIdleRefresh
  }

  return {
    entries,
    filter,
    queryFilter,
    page,
    setPage,
    panel,
    setPanel,
    prefs,
    setPrefs,
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
