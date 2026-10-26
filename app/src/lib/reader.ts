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
  createSignal,
  createStore,
  refresh,
  snapshot,
} from 'solid-js'

import * as api from '../server/actions'
import { hasView, type EntriesFilter } from '../shared/filter'
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
import type { EntriesResult, EntrySummary, FeedPanelResult, ViewCursor } from '../shared/types'
import { compareTitlesCI, computeUnreadCount } from '../shared/util'

/** One screenful; scrolling asks for another. */
const PAGE_SIZE = 100
/** How many written ids are kept for reconciliation. */
const DIRTY_LIMIT = 500
/** How long after a write burst the sidebar's counters are re-read. */
const PANEL_SETTLE_MS = 300
const POLL_MS = 60_000

type ListState = {
  entries: EntrySummary[]
  nextCursor: ViewCursor | null
  /** Which view these rows belong to; a different one starts over. */
  viewKey: string
  /** Which generation of that view; a bump means re-read from the top. */
  gen: number
}

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
  /** Rows to hold; grows as you scroll. */
  wanted: number
  /** Rows this session wrote, reconciled on every read. */
  dirtyIds: EntryId[]
  /** Bumped to ask the list to start over from the newest row. */
  listGen: number
  /** Bumped when the list is replaced, so observers can re-arm. */
  pageGen: number
}

/** A rejection's status, whether it arrives as a Response or a wrapped error. */
const statusOf = (error: unknown): number | null => {
  if (error instanceof Response) return error.status
  const status = (error as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** What to tell the reader when a write is rejected. */
export const describeWriteFailure = (error: unknown, what: string): string => {
  if (statusOf(error) === 401) return 'Your session expired. Sign in again to keep saving.'
  if (statusOf(error) === 403) return `You cannot ${what}.`
  return `Could not ${what}. The list has been refreshed.`
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
    wanted: PAGE_SIZE,
    dirtyIds: [],
    listGen: 0,
    pageGen: 0,
  })

  const currentFeedId = (): FeedId | null => (filter().feedId as FeedId | undefined) ?? null

  /** The URL's view: the key the list's derive resets on. Declared before the
   *  projections, because hydration can run a derive while this body is still
   *  executing (a `const` below would be in its temporal dead zone). */
  const queryFilter = createMemo<EntriesFilter>(() => filter())
  const viewKey = createMemo(() => identity(filter()))

  // ---- server data ----
  /**
   * The list, as a projection in its *draft* form: the derive receives what is
   * already on screen, appends only the page it does not have, and reconciles the
   * rows this session has written.
   */
  const [page, setPage] = createOptimisticStore<ListState>(
    async (draft) => {
      // Read tracked state BEFORE the first await: reads after one see the
      // snapshot taken when the compute started, so a write that landed while a
      // fetch was in flight would still look like the old value.
      const key = viewKey()
      const wanted = session.wanted
      const dirty = [...session.dirtyIds]
      const gen = session.listGen
      // No view (the home page) means no window to read: asking would be a
      // request for entries with no filter, which the server refuses.
      if (!hasView(filter())) {
        draft.viewKey = key
        draft.gen = gen
        draft.entries = []
        draft.nextCursor = null
        return
      }
      // A different view — or a request to re-read from the top — starts over.
      if (draft.viewKey !== key || draft.gen !== gen) {
        draft.viewKey = key
        draft.gen = gen
        draft.entries = []
        draft.nextCursor = null
      }
      if (draft.entries.length === 0) {
        const first = await api.viewEntries(wire(filter()), null)
        draft.entries = snapshot(first.entries)
        draft.nextCursor = first.nextCursor
      } else {
        while (draft.entries.length < wanted && draft.nextCursor) {
          const next = await api.viewEntries(wire(filter()), wire(draft.nextCursor))
          draft.entries.push(...snapshot(next.entries))
          draft.nextCursor = next.nextCursor
        }
      }
      // Rows this session wrote: the server has the last word on their state.
      if (dirty.length > 0) {
        const fresh = await api.entriesByIds(wire(dirty))
        const byId = new Map(fresh.map((row) => [row.id, row]))
        for (const row of draft.entries) {
          const server = byId.get(row.id)
          if (server) Object.assign(row, server)
        }
      }
    },
    { entries: [], nextCursor: null, viewKey: '', gen: 0 },
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

  /** Does this feed have a stored icon? Without one the browser must not ask. */
  const hasIcon = (feedId: FeedId): boolean =>
    panel.allFeeds.find((feed) => feed.id === feedId)?.iconUrl != null

  // ---- writes ----

  const [writeError, setWriteError] = createSignal<string | null>(null)

  /**
   * Run a write and, if it is rejected, say so and put the screen back on truth.
   *
   * There is no compensation to write: the framework already discarded the
   * optimistic layer, so all that is left is telling the reader what happened and
   * re-reading — which is also what clears a stale row from the list.
   */
  const runWrite = async (what: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work()
      setWriteError(null)
    } catch (error) {
      setWriteError(describeWriteFailure(error, what))
      refresh(page)
      refresh(panel)
      refresh(prefs)
    }
  }

  /** Fire-and-forget `runWrite`, for writes whose caller does not wait. */
  const runWriteNow = (what: string, work: () => Promise<unknown>): void => {
    void runWrite(what, work)
  }

  const dismissWriteError = (): void => {
    setWriteError(null)
  }

  /** Remember which rows this session wrote, so reads reconcile only those. */
  const markDirty = (entryIds: EntryId[]): void => {
    setSession((draft) => {
      const merged = [...draft.dirtyIds]
      for (const id of entryIds) if (!merged.includes(id)) merged.push(id)
      draft.dirtyIds = merged.slice(-DIRTY_LIMIT)
    })
  }

  /** Sidebar counters follow writes, a beat later rather than per write. */
  let panelTimer: ReturnType<typeof setTimeout> | undefined
  const settlePanel = (): void => {
    clearTimeout(panelTimer)
    panelTimer = setTimeout(() => refresh(panel), PANEL_SETTLE_MS)
  }

  /**
   * Mark entries read (or unread): optimistic, then the server's answer.
   *
   * The rows stay on screen because the derive only appends and never replaces;
   * after the write it re-reads just these ids, so each row settles on whatever
   * the server says without re-fetching the window.
   */
  const setStatus = (entryIds: EntryId[], status: 'read' | 'unread'): void => {
    if (entryIds.length === 0) return
    // Outside the transition: a plain-store write inside one is reverted with it.
    markDirty(entryIds)
    runWriteNow(status === 'read' ? 'mark that read' : 'mark that unread', () =>
      action(function* () {
      setPage((draft) => {
        for (const entryId of entryIds) {
          const entry = draft.entries.find((candidate) => candidate.id === entryId)
          if (entry) entry.status = status
        }
      })
      yield api.setStatus(entryIds, status)
      yield refresh(page)
      settlePanel()
      })(),
    )
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
    runWriteNow(next ? 'star that' : 'unstar that', () =>
      action(function* () {
      setPage((draft) => {
        const target = draft.entries.find((candidate) => candidate.id === entryId)
        if (target) target.starred = next
      })
      yield api.setStarred([entryId], next)
      markDirty([entryId])
      yield refresh(page)
      })(),
    )
  }

  // ---- paging: a bigger window ----

  /** Scroll further: the derive appends one more page. */
  const loadMore = (): void => {
    if (!page.nextCursor) return
    setSession((draft) => {
      draft.wanted += PAGE_SIZE
    })
    refresh(page)
  }

  const checkTail = (): void => {
    if (session.atListEnd) loadMore()
  }

  // A new view means a new list. Keyed on the URL filter (a string), not on the
  // projection's value: that would re-fire on every read and loop, because the
  // reset writes the projection's own inputs.
  createEffect(viewKey, () => {
    setSession((draft) => {
      draft.currentId = null
      draft.navRequest = null
      draft.userHasScrolled = false
      // Write only what changes: a fresh `[]` invalidates the list's derive,
      // which then reads a window for a view the reader has not opened.
      if (draft.keepUnreadIds.length > 0) draft.keepUnreadIds = []
      if (draft.expandedIds.length > 0) draft.expandedIds = []
      draft.viewModeOverride = null
      draft.wanted = PAGE_SIZE
      if (draft.dirtyIds.length > 0) draft.dirtyIds = []
      draft.listGen = 0
      draft.pageGen++
    })
  })

  // ---- writes that change the view ----

  const refreshFeeds = async (): Promise<void> => {
    // New entries arrive at the top; the draft only appends, so ask it to start
    // over rather than expecting a refresh to reveal them.
    setSession((draft) => {
      draft.listGen++
    })
    refresh(page)
    refresh(panel)
  }

  const setViewMode = (viewMode: 'expanded' | 'list'): void => {
    setSession((draft) => {
      draft.viewModeOverride = viewMode
    })
    const feedId = currentFeedId()
    if (!feedId) return
    runWriteNow('save that preference', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], viewMode }
        })
        yield api.setPrefs(feedId, { viewMode })
        refresh(prefs)
      })(),
    )
  }

  const setSort = (sort: 'oldest' | 'newest'): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    runWriteNow('save that sort order', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], sort }
        })
        yield api.setPrefs(feedId, { sort })
        refresh(prefs)
        refresh(page)
      })(),
    )
  }

  const setHideReadItems = (hideReadItems: boolean): void => {
    const feedId = currentFeedId()
    if (!feedId) return
    runWriteNow('save that preference', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], hideReadItems }
        })
        yield api.setPrefs(feedId, { hideReadItems })
        refresh(prefs)
        refresh(page)
      })(),
    )
  }

  const toggleHideEmptyFeeds = (): void => {
    const next = !(prefs.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
    runWriteNow('save that preference', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.userPrefs = { ...draft.userPrefs, hideEmptyFeeds: next }
        })
        yield api.setPrefs(null, { hideEmptyFeeds: next })
        refresh(prefs)
        refresh(panel)
      })(),
    )
  }

  const toggleAutoRead = (feedId: FeedId): void => {
    const list = prefs.userPrefs.disabledAutoReadFeeds ?? []
    const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
    runWriteNow('save that preference', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.userPrefs = { ...draft.userPrefs, disabledAutoReadFeeds: next }
        })
        yield api.setPrefs(null, { disabledAutoReadFeeds: next })
        refresh(prefs)
      })(),
    )
  }

  const toggleFavorite = (feedId: FeedId): void => {
    const next = !isFavorite(feedId)
    runWriteNow('save that preference', () =>
      action(function* () {
        setPrefs((draft) => {
          draft.feedPrefs[feedId] = { ...draft.feedPrefs[feedId], favorite: next }
        })
        yield api.setPrefs(feedId, { favorite: next })
        refresh(prefs)
      })(),
    )
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

  /** Edit the rename field; the draft lives in the session so both editors share it. */
  const setRenameTitle = (value: string): void => {
    setSession((draft) => {
      draft.renameTitle = value
    })
  }

  /**
   * Rename a feed or category: optimistic in the sidebar, then the server's copy.
   *
   * The sidebar and the feed popover both drive this — one title, one write, one
   * reconciliation — rather than each keeping its own editor state.
   */
  const saveRename = async (): Promise<void> => {
    const id = session.renameId
    const kind = session.renameKind
    const title = session.renameTitle.trim()
    if (id == null || kind == null || !title) return
    const rename = (draft: FeedPanelResult) => {
      if (kind === 'feed') {
        for (const feed of draft.allFeeds) if (feed.id === id) feed.title = title
        for (const feed of draft.feeds) if (feed.id === id) feed.title = title
      } else {
        for (const category of draft.categories) if (category.id === id) category.title = title
      }
    }
    // Out of the transition, so the draft stays put if the write is rejected.
    rename(panel)
    await runWrite('rename that', () =>
      action(function* () {
      yield kind === 'feed'
        ? api.renameFeed(id as FeedId, title)
        : api.renameCategory(id as CategoryId, title)
      cancelRename()
      refresh(panel)
      })(),
    )
  }

  const unsubscribe = async (feedId: FeedId): Promise<void> => {
    await runWrite('unsubscribe from that feed', async () => {
      await api.unsubscribe(feedId)
      refresh(panel)
      refresh(page)
    })
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
      // Only when the reader has reached the end: mid-scroll, the list is theirs.
      if (session.atListEnd) {
        setSession((draft) => {
          draft.listGen++
        })
        refresh(page)
      }
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
    hasIcon,
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
    setRenameTitle,
    saveRename,
    writeError,
    dismissWriteError,
    unsubscribe,
    markIconFailed,
    startIdleRefresh,
  }
}

export type Reader = ReturnType<typeof createReader>
