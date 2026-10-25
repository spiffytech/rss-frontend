/**
 * Client state for the reading view.
 *
 * Two kinds of data live here, and the split is deliberate:
 *  - **server truth** (entries, sidebar, prefs, the resolved filter) is replaced
 *    wholesale by each load. Server wins, always.
 *  - **client session** (reading anchor, expansion, scroll flags, the rename
 *    editor) never crosses the API and is reset when a fresh list arrives.
 *
 * Loaders are imperative functions that write into the store, not resources: the
 * reading pane keeps its rows on screen while the next window loads, so there is
 * no boundary to fall back to and nothing to flash.
 */
import { createStore } from 'solid-js'

import * as api from '../server/actions'
import type { EntriesFilter } from '../shared/filter'
import type { CategoryId, EntryId, EntryStatus, FeedId } from '../shared/ids'
import {
  DEFAULT_HIDE_EMPTY_FEEDS,
  DEFAULT_HIDE_READ_ITEMS,
  DEFAULT_SORT,
  DEFAULT_VIEW_MODE,
  resolveViewFilter,
  type FeedPrefs,
  type UserPrefs,
} from '../shared/prefs'
import { shouldAutoRead } from '../shared/reading'
import type { EntrySummary, FeedPanelResult, ViewCursor } from '../shared/types'
import { computeUnreadCount } from '../shared/util'

export type ReaderState = {
  // ---- server truth ----
  entries: EntrySummary[]
  nextCursor: ViewCursor | null
  panel: FeedPanelResult
  userPrefs: UserPrefs
  feedPrefs: Record<FeedId, FeedPrefs>
  filter: EntriesFilter
  /** Every feed title the server has ever told us. The sidebar hides feeds with
   *  no unread items (`hideEmptyFeeds`), so without this a feed you have just
   *  finished reading drops out of `panel.feeds` and the header title degrades
   *  to its id. */
  feedTitles: Record<FeedId, string>
  // ---- loading ----
  loadingMore: boolean
  // ---- client session ----
  currentId: EntryId | null
  navRequest: EntryId | null
  userHasScrolled: boolean
  atListEnd: boolean
  keepUnreadIds: EntryId[]
  expandedIds: EntryId[]
  viewModeOverride: 'expanded' | 'list' | null
  /** Bumped whenever a whole new list replaces the old one; watchers use it to
   *  reset the scroll position and re-arm the reading-anchor observer. */
  pageGen: number
  /** Feed id → true once its <img> errored (letter fallback takes over). */
  iconFailed: Record<string, boolean>
  renameId: string | null
  renameKind: 'feed' | 'category' | null
  renameTitle: string
}

export const [reader, setReader] = createStore<ReaderState>({
  entries: [],
  nextCursor: null,
  panel: { feeds: [], categories: [], counters: {} },
  userPrefs: {},
  feedPrefs: {},
  filter: {},
  feedTitles: {},
  loadingMore: false,
  currentId: null,
  navRequest: null,
  userHasScrolled: false,
  atListEnd: false,
  keepUnreadIds: [],
  expandedIds: [],
  viewModeOverride: null,
  pageGen: 0,
  iconFailed: {},
  renameId: null,
  renameKind: null,
  renameTitle: '',
})

// ---- Loading ----

export const loadBootstrap = async (filter: EntriesFilter): Promise<void> => {
  const result = await api.bootstrap(filter)
  setReader((state) => {
    // Prefs must land before the display set resolves: applyDisplaySet reads them
    // to pick the view mode/sort, and setting the filter first keeps the controls
    // in step with the rows the server just returned.
    state.userPrefs = result.userPrefs
    state.feedPrefs = result.feedPrefs
    state.filter = result.filter
    applyDisplaySet(state, result.entries)
    state.nextCursor = result.nextCursor
    applyPanel(state, {
      feeds: result.feeds,
      categories: result.categories,
      counters: result.counters,
    })
  })
}

export const reloadEntries = async (filter: EntriesFilter): Promise<void> => {
  await flushPending()
  // Callers may pass the bare identity filter from the URL; fold in this feed's
  // saved view prefs so the fetched order matches the controls.
  const resolved = resolveViewFilter(filter, reader.feedPrefs)
  const result = await api.entries(resolved, null)
  setReader((state) => {
    state.filter = resolved
    applyDisplaySet(state, result.entries)
    state.nextCursor = result.nextCursor
  })
  const snapshot = await api.panel((resolved.feedId as FeedId | undefined) ?? null)
  setReader((state) => applyPanel(state, snapshot))
}

/** Full list replacement resets the reading session like a fresh page load. */
const applyDisplaySet = (state: ReaderState, entries: EntrySummary[]): void => {
  state.entries = entries
  state.currentId = null
  state.navRequest = null
  state.userHasScrolled = false
  state.keepUnreadIds = []
  state.expandedIds = []
  state.viewModeOverride = null
  resolveViewPrefs(state)
  state.pageGen++
}

/** Effective view prefs for the current feed (old resolveViewPrefs). */
const resolveViewPrefs = (state: ReaderState): void => {
  const prefs = state.filter.feedId ? state.feedPrefs[state.filter.feedId as FeedId] : undefined
  state.viewModeOverride = prefs?.viewMode ?? null
  state.filter.sort = prefs?.sort ?? DEFAULT_SORT
  state.filter.hideReadItems = prefs?.hideReadItems ?? DEFAULT_HIDE_READ_ITEMS
}

/** Apply a sidebar snapshot, remembering the titles it carries. Every panel
 *  assignment goes through here so the title cache cannot go stale-by-omission. */
const applyPanel = (state: ReaderState, next: FeedPanelResult): void => {
  state.panel = next
  for (const feed of next.feeds) state.feedTitles[feed.id] = feed.title
}

/**
 * Refetch the sidebar in place (pref toggles, renames) — no entries reload, so
 * the reading position and list survive. The current feed is passed so the
 * snapshot still names it when `hideEmptyFeeds` would otherwise omit it.
 */
export const refreshPanel = async (): Promise<void> => {
  const next = await api.panel(currentFeedId())
  setReader((state) => applyPanel(state, next))
}

/** Identity filter change (URL navigation). */
export const setFilter = (next: EntriesFilter): void => {
  setReader((state) => {
    state.filter = next
    resolveViewPrefs(state)
  })
}

/**
 * Scroll-sentinel page fetch: appends the next window (old infinite scroll).
 * A page that is entirely duplicates must not stall pagination (old spec: the
 * bulk-second window), so keep paging while a page yields nothing fresh —
 * bounded, so a misbehaving server cannot loop us forever.
 */
export const loadMore = async (): Promise<void> => {
  if (reader.loadingMore) return
  setReader((state) => { state.loadingMore = true })
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cursor = reader.nextCursor
      if (!cursor) return
      const result = await api.entries(reader.filter, cursor)
      const seen = new Set(reader.entries.map((entry) => entry.id))
      const fresh = result.entries.filter((entry) => !seen.has(entry.id))
      setReader((state) => {
        if (fresh.length > 0) state.entries.push(...fresh)
        state.nextCursor = result.nextCursor
      })
      if (fresh.length > 0 || !result.nextCursor) return
    }
  } finally {
    setReader((state) => { state.loadingMore = false })
  }
}

/**
 * End-of-list recheck (old checkTail): the window is exhausted, so ask the
 * server for anything beyond our loaded tail — items that arrived since the view
 * opened — and APPEND them in place (scroll preserved). If the server says more
 * remains, normal pagination resumes via the returned cursor.
 *
 * Skipped for search views (their two-phase cursor can't be rebuilt from one
 * entry) and for newest sort (fresh items surface at the top; injecting at the
 * tail would trip the sweep and auto-read them unseen).
 */
export const checkTail = async (): Promise<void> => {
  if (reader.nextCursor || reader.loadingMore || reader.entries.length === 0) return
  if (reader.filter.search || reader.filter.sort === 'newest') return
  const tail = reader.entries[reader.entries.length - 1]!
  setReader((state) => { state.loadingMore = true })
  try {
    const result = await api.entries(reader.filter, { publishedAt: tail.publishedAt, id: tail.id })
    const seen = new Set(reader.entries.map((entry) => entry.id))
    const fresh = result.entries.filter((entry) => !seen.has(entry.id))
    setReader((state) => {
      if (fresh.length > 0) state.entries.push(...fresh)
      state.nextCursor = result.nextCursor
    })
  } finally {
    setReader((state) => { state.loadingMore = false })
  }
}

/**
 * Refresh command (FeedMenu): ask the server to poll this view's feeds now —
 * the old app queued a Miniflux refresh and never waited either — then re-read
 * the view. New items land on the scheduler's next tick (≤60s) and surface
 * through the idle tail recheck.
 */
export const refreshFeeds = async (): Promise<void> => {
  await api.refresh(reader.filter)
  await reloadEntries(reader.filter)
}

// ---- Derived labels ----

export const currentTitle = (): string => {
  const filter = reader.filter
  if (filter.feedId != null && filter.feedId !== '') {
    const feedId = filter.feedId as FeedId
    // The sidebar hides feeds with no unread items, so the lookup can miss the
    // very feed being read; fall back to what we were told earlier, then to the
    // loaded entries' own feed title, and only then to the id.
    return (
      reader.panel.feeds.find((feed) => feed.id === feedId)?.title ??
      reader.feedTitles[feedId] ??
      reader.entries.find((entry) => entry.feedId === feedId)?.feedTitle ??
      `Feed ${feedId}`
    )
  }
  if (filter.starred) return 'Starred'
  return 'Latest'
}

export const unreadCount = (): number | null =>
  computeUnreadCount(reader.filter, reader.panel.feeds, reader.panel.counters)

// ---- Read/unread: local first, debounced flush, revert on failure ----

const BATCH_MS = 300
/** Desired status per entry, waiting to be sent. */
const pending = new Map<EntryId, 'read' | 'unread'>()
/** Status each entry had before this batch touched it — the revert target. */
const beforeBatch = new Map<EntryId, EntryStatus>()
let flushTimer: ReturnType<typeof setTimeout> | undefined

/** Write a status into the store and keep the per-feed counters in step. */
const applyStatus = (entryId: EntryId, status: 'read' | 'unread'): void => {
  setReader((state) => {
    const entry = state.entries.find((candidate) => candidate.id === entryId)
    if (!entry || entry.status === status) return
    entry.status = status
    const counters = state.panel.counters
    counters[entry.feedId] = Math.max(0, (counters[entry.feedId] ?? 0) + (status === 'read' ? -1 : 1))
  })
}

const setLocalStatus = (entryId: EntryId, status: 'read' | 'unread'): void => {
  const entry = reader.entries.find((candidate) => candidate.id === entryId)
  if (!entry || entry.status === status) return
  if (!pending.has(entryId)) beforeBatch.set(entryId, entry.status)
  applyStatus(entryId, status)
  pending.set(entryId, status)
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushPending(), BATCH_MS)
}

/**
 * Send the batch. On failure every entry in it goes back to the status it had
 * before the batch — not a blanket reload, which would also throw away the
 * reading position.
 *
 * A Solid `action()` would give this revert for free, but an action owns a
 * transaction and this one spans a debounce timer: the write happens in a later
 * task than the call. An explicit snapshot/revert is the honest shape here.
 */
export const flushPending = async (): Promise<void> => {
  clearTimeout(flushTimer)
  flushTimer = undefined
  if (pending.size === 0) return

  const reads: EntryId[] = []
  const unreads: EntryId[] = []
  for (const [id, status] of pending) (status === 'read' ? reads : unreads).push(id)
  const snapshot = new Map(beforeBatch)
  pending.clear()
  beforeBatch.clear()

  const revert = (ids: EntryId[]) => {
    for (const id of ids) {
      const previous = snapshot.get(id)
      if (previous === 'read' || previous === 'unread') applyStatus(id, previous)
    }
  }

  try {
    if (reads.length) await api.setStatus(reads, 'read')
  } catch (error) {
    console.error('failed to mark entries read', error)
    revert(reads)
  }
  try {
    if (unreads.length) await api.setStatus(unreads, 'unread')
  } catch (error) {
    console.error('failed to mark entries unread', error)
    revert(unreads)
  }
}

/** Toggle read/unread (m key, ◉ button); unread enters the keep-unread set. */
export const toggleRead = (entryId: EntryId): void => {
  const entry = reader.entries.find((candidate) => candidate.id === entryId)
  if (!entry) return
  const next = entry.status === 'read' ? 'unread' : 'read'
  if (next === 'unread') {
    if (!reader.keepUnreadIds.includes(entryId))
      setReader((state) => { state.keepUnreadIds.push(entryId) })
  } else {
    setReader((state) => { state.keepUnreadIds = state.keepUnreadIds.filter((id) => id !== entryId) })
  }
  setLocalStatus(entryId, next)
}

/** Toggle list-view expansion; opening an entry is an explicit read. */
export const toggleExpanded = (entryId: EntryId): void => {
  if (reader.expandedIds.includes(entryId)) {
    setReader((state) => { state.expandedIds = state.expandedIds.filter((id) => id !== entryId) })
    return
  }
  setReader((state) => { state.expandedIds.push(entryId) })
  autoRead(entryId, false, { ignoreFeedSetting: true, explicit: true })
}

/**
 * Single guarded entry point for auto-read — every trigger (scroll sweep,
 * j/k/buttons, card click) funnels here so the guard list is identical
 * regardless of how the read was provoked. `viaScroll` marks the passive scroll
 * trigger, which still requires the user to have actually scrolled; explicit
 * triggers (key/button/click) are deliberate by definition.
 */
export const autoRead = (
  entryId: EntryId,
  viaScroll = false,
  opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
): void => {
  // Never auto-read during a search — scrolling results shouldn't mark matches
  // read.
  if (reader.filter.search) return
  const entry = reader.entries.find((candidate) => candidate.id === entryId)
  if (!entry) return
  const prefs = reader.filter.feedId ? reader.feedPrefs[reader.filter.feedId as FeedId] : undefined
  if (
    !shouldAutoRead({
      viewMode: reader.viewModeOverride ?? prefs?.viewMode ?? DEFAULT_VIEW_MODE,
      userHasScrolled: viaScroll ? reader.userHasScrolled : true,
      disabledAutoReadFeeds: (reader.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
      keepUnreadIds: reader.keepUnreadIds,
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

/** j/k: move the reading anchor and auto-read the new one (explicit). */
export const moveAndRead = (delta: 1 | -1): void => {
  const ids = reader.entries.map((entry) => entry.id)
  if (ids.length === 0) return
  const currentIndex = reader.currentId ? ids.indexOf(reader.currentId) : -1
  // Unselected (-1) clamps to the first entry for BOTH directions (old move()).
  const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + delta))
  const nextId = ids[nextIndex]!
  setReader((state) => {
    state.currentId = nextId
    state.navRequest = nextId
  })
  autoRead(nextId)
}

/** Shift+A / toolbar ✓: mark exactly the fetched display set read. */
export const markDisplayed = (): void => {
  const ids = reader.entries.filter((entry) => entry.status !== 'read').map((entry) => entry.id)
  for (const id of ids) setLocalStatus(id, 'read')
  void flushPending()
}

export const toggleStar = async (entryId: EntryId): Promise<void> => {
  const entry = reader.entries.find((candidate) => candidate.id === entryId)
  if (!entry) return
  const next = !entry.starred
  // Pessimistic (old behavior): the entry flips only once the server confirms.
  await api.setStarred([entryId], next)
  setReader((state) => {
    const target = state.entries.find((candidate) => candidate.id === entryId)
    if (target) target.starred = next
  })
}

// ---- View prefs (per feed persisted; aggregates are session-only, matching
// the old store, whose global defaults were hardcoded) ----

const currentFeedId = (): FeedId | null => (reader.filter.feedId as FeedId | undefined) ?? null

/**
 * The view mode in effect right now: a session override, else the current
 * feed's saved pref, else the default. The menu toggle, its label, the `v` key
 * and the entry list all resolve through this — deriving the next mode from the
 * raw override alone made the first toggle a no-op whenever no pref was saved.
 */
export const effectiveViewMode = (): 'expanded' | 'list' =>
  reader.viewModeOverride ??
  (reader.filter.feedId ? reader.feedPrefs[reader.filter.feedId as FeedId]?.viewMode : undefined) ??
  DEFAULT_VIEW_MODE

const rememberFeedPref = (feedId: FeedId, patch: Partial<FeedPrefs>): void => {
  setReader((state) => {
    state.feedPrefs[feedId] = { ...state.feedPrefs[feedId], ...patch }
  })
}

export const setViewMode = (viewMode: 'expanded' | 'list'): void => {
  setReader((state) => { state.viewModeOverride = viewMode })
  const feedId = currentFeedId()
  if (feedId) {
    rememberFeedPref(feedId, { viewMode })
    void api.setPrefs(feedId, { viewMode })
  }
}

export const setSort = (sort: 'oldest' | 'newest'): void => {
  setReader((state) => { state.filter.sort = sort })
  const feedId = currentFeedId()
  if (feedId) {
    rememberFeedPref(feedId, { sort })
    void api.setPrefs(feedId, { sort })
  }
  void reloadEntries(reader.filter)
}

export const setHideReadItems = (hideReadItems: boolean): void => {
  setReader((state) => { state.filter.hideReadItems = hideReadItems })
  const feedId = currentFeedId()
  if (feedId) {
    rememberFeedPref(feedId, { hideReadItems })
    void api.setPrefs(feedId, { hideReadItems })
  }
  void reloadEntries(reader.filter)
}

export const toggleHideEmptyFeeds = async (): Promise<void> => {
  const next = !(reader.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
  try {
    await api.setPrefs(null, { hideEmptyFeeds: next })
  } catch {
    return // a failed persist leaves the row as it was (the old app awaited too)
  }
  setReader((state) => { state.userPrefs.hideEmptyFeeds = next })
  // The server omits empty feeds from `panel.feeds` while this pref is on, so
  // flipping it off only reveals them once the snapshot is refetched.
  try {
    await refreshPanel()
  } catch {
    // The 60s idle poll will catch the sidebar up.
  }
}

export const toggleAutoRead = async (feedId: FeedId): Promise<void> => {
  const list = reader.userPrefs.disabledAutoReadFeeds ?? []
  const next = list.includes(feedId) ? list.filter((id) => id !== feedId) : [...list, feedId]
  try {
    await api.setPrefs(null, { disabledAutoReadFeeds: next })
  } catch {
    return // idem: no silent flip when the write fails
  }
  setReader((state) => { state.userPrefs.disabledAutoReadFeeds = next })
}

// ---- Icon fallback + rename editor ----

export const markIconFailed = (feedId: FeedId): void => {
  setReader((state) => { state.iconFailed[feedId] = true })
}

export const startRename = (id: string, kind: 'feed' | 'category', title: string): void => {
  setReader((state) => {
    state.renameId = id
    state.renameKind = kind
    state.renameTitle = title
  })
}

export const cancelRename = (): void => {
  setReader((state) => {
    state.renameId = null
    state.renameKind = null
    state.renameTitle = ''
  })
}

export const saveRename = async (): Promise<void> => {
  const id = reader.renameId
  const kind = reader.renameKind
  const title = reader.renameTitle.trim()
  if (id == null || kind == null || !title) return
  if (kind === 'feed') {
    await api.renameFeed(id as FeedId, title)
  } else {
    await api.renameCategory(id as CategoryId, title)
  }
  await refreshPanel()
  cancelRename()
}

export const unsubscribe = async (feedId: FeedId): Promise<void> => {
  await api.unsubscribe(feedId)
  // No currentFeed: asking the panel to name the feed we just deleted is pointless.
  const next = await api.panel(null)
  setReader((state) => applyPanel(state, next))
}

// ---- Idle refresh (old polling composable): keep the sidebar honest while the
// page sits open, and extend the current view when items arrive at its tail.
// Tail semantics are the old ones — checked every poll AND on reaching the end,
// appended in place. One deliberate delta: the panel refreshes every poll rather
// than every 10th, because the old lean-counters tier existed to save Miniflux
// API round-trips and panel() is one local query here. ----

const POLL_MS = 60_000
let pollTimer: ReturnType<typeof setInterval> | undefined

const stopIdleRefresh = (): void => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = undefined
}

export const startIdleRefresh = (): (() => void) => {
  if (pollTimer) return stopIdleRefresh
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        const next = await api.panel(currentFeedId())
        setReader((state) => applyPanel(state, next))
        if (reader.atListEnd) await checkTail()
      } catch (error) {
        console.error('idle refresh failed', error)
      }
    })()
  }, POLL_MS)
  return stopIdleRefresh
}
