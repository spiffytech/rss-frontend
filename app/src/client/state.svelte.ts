/**
 * Client state (Svelte 5 runes) — the port of the old reader/feeds stores.
 * Server truth wins on reload; read/unread flips are optimistic and flushed in
 * batches. autoRead() is the single guarded entry point every trigger funnels
 * through (scroll sweep, j/k, card click) so the guard list is identical
 * regardless of what provoked the read.
 */
import { api } from './api.js'
import { computeUnreadCount } from '../shared/util.js'
import { clampNavIndex, shouldAutoRead } from '../shared/reading.js'
import {
  DEFAULT_HIDE_READ_ITEMS,
  DEFAULT_SORT,
  DEFAULT_VIEW_MODE,
  type FeedPrefs,
  type UserPrefs,
} from '../shared/prefs'
import type { EntriesFilter } from '../shared/filter'
import type { EntrySummary, FeedPanelResult, SessionInfo, ViewCursor } from '../shared/types'
import type { EntryId, FeedId } from '../shared/ids'

export const appState = $state({
  session: { authenticated: false } as SessionInfo,
  entries: [] as EntrySummary[],
  nextCursor: null as ViewCursor | null,
  loadingMore: false,
  loading: false,
  panel: { feeds: [], categories: [], counters: {} } as FeedPanelResult,
  userPrefs: {} as UserPrefs,
  feedPrefs: {} as Record<string, FeedPrefs>,
  filter: {} as EntriesFilter,
  // reading session (client-only; never crosses the API)
  currentId: null as EntryId | null,
  navRequest: null as EntryId | null,
  userHasScrolled: false,
  atListEnd: false,
  keepUnreadIds: [] as EntryId[],
  expandedIds: [] as EntryId[],
  viewModeOverride: null as 'expanded' | 'list' | null,
  pageGen: 0,
  // icon fallback: feed id -> true when the <img> errored
  iconFailed: {} as Record<string, boolean>,
  // inline rename editor state
  renameId: null as string | null,
  renameKind: null as 'feed' | 'category' | null,
  renameTitle: '',
})

// ---- loading ----

export async function loadBootstrap(filter: EntriesFilter): Promise<void> {
  appState.loading = true
  try {
    const result = await api.bootstrap(filter)
    applyDisplaySet(result.entries)
    appState.nextCursor = result.nextCursor
    appState.panel = { feeds: result.feeds, categories: result.categories, counters: result.counters }
    appState.userPrefs = result.userPrefs
    appState.feedPrefs = result.feedPrefs
    appState.filter = filter
    appState.session = { authenticated: true, username: appState.session.username }
  } finally {
    appState.loading = false
  }
}

export async function reloadEntries(filter: EntriesFilter): Promise<void> {
  appState.loading = true
  try {
    await flushPending()
    const result = await api.entries(filter)
    applyDisplaySet(result.entries)
    appState.nextCursor = result.nextCursor
    appState.panel = await api.panel()
    appState.filter = filter
  } finally {
    appState.loading = false
  }
}

/** Old store's reloadView name. */
export const reloadView = reloadEntries

/** Full list replacement resets the reading session like a fresh page load. */
function applyDisplaySet(entries: EntrySummary[]): void {
  appState.entries = entries
  appState.currentId = null
  appState.navRequest = null
  appState.userHasScrolled = false
  appState.keepUnreadIds = []
  appState.expandedIds = []
  appState.viewModeOverride = null
  resolveViewPrefs()
  appState.pageGen++
}

/** Effective view prefs for the current feed (old resolveViewPrefs). */
function resolveViewPrefs(): void {
  const prefs = appState.filter.feedId ? appState.feedPrefs[appState.filter.feedId] : undefined
  appState.viewModeOverride = prefs?.viewMode ?? null
  appState.filter.sort = prefs?.sort ?? DEFAULT_SORT
  appState.filter.hideReadItems = prefs?.hideReadItems ?? DEFAULT_HIDE_READ_ITEMS
}

/** Identity filter change (URL navigation). */
export function setFilter(next: EntriesFilter): void {
  appState.filter = next
  resolveViewPrefs()
}

/** Scroll-sentinel page fetch: appends the next window (old infinite scroll). */
export async function loadMore(): Promise<void> {
  const cursor = appState.nextCursor
  if (!cursor || appState.loadingMore) return
  appState.loadingMore = true
  try {
    const result = await api.entries(appState.filter, cursor)
    const seen = new Set(appState.entries.map((e) => e.id))
    const fresh = result.entries.filter((e) => !seen.has(e.id))
    if (fresh.length > 0) appState.entries.push(...fresh)
    appState.nextCursor = result.nextCursor
  } finally {
    appState.loadingMore = false
  }
}

/**
 * Tail recheck at the end of the list (idle refresh hook): the window is
 * exhausted, so a reload picks up items that arrived since. Fresh list resets
 * the session like a page load.
 */
export async function loadEnd(): Promise<void> {
  if (appState.nextCursor || appState.loadingMore || !appState.userHasScrolled || !appState.atListEnd) return
  await reloadEntries(appState.filter)
}

/** Idle refresh: counters every poll, full panel every Nth (see polling below). */
export async function refresh(): Promise<void> {
  await reloadEntries(appState.filter)
}

// ---- Derived labels (old store's currentTitle / unreadCount) ----

export function currentTitle(): string {
  const filter = appState.filter
  if (filter.feedId != null && filter.feedId !== '') {
    return appState.panel.feeds.find((f) => f.id === filter.feedId)?.title ?? `Feed ${filter.feedId}`
  }
  if (filter.starred) return 'Starred'
  return 'Latest'
}

export function unreadCount(): number | null {
  return computeUnreadCount(appState.filter, appState.panel.feeds, appState.panel.counters)
}

// ---- Optimistic + batched read/unread (BATCH_MS debounce, old store) ----

const BATCH_MS = 300
const pending = new Map<EntryId, 'read' | 'unread'>()
let flushTimer: ReturnType<typeof setTimeout> | null = null

function setLocalStatus(entryId: EntryId, status: 'read' | 'unread'): void {
  const entry = appState.entries.find((e) => e.id === entryId)
  if (!entry || entry.status === status) return
  entry.status = status
  const counters = appState.panel.counters
  counters[entry.feedId] = Math.max(0, (counters[entry.feedId] ?? 0) + (status === 'read' ? -1 : 1))
  pending.set(entryId, status)
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => void flushPending(), BATCH_MS)
}

export function enqueueStatus(entryId: EntryId, status: 'read' | 'unread'): void {
  setLocalStatus(entryId, status)
}

export async function flushPending(): Promise<void> {
  flushTimer = null
  if (pending.size === 0) return
  const reads: EntryId[] = []
  const unreads: EntryId[] = []
  for (const [id, status] of pending) (status === 'read' ? reads : unreads).push(id)
  pending.clear()
  if (reads.length) await api.setStatus(reads, 'read')
  if (unreads.length) await api.setStatus(unreads, 'unread')
}

/** Toggle read/unread (m key, ◉ button); unread enters the keep-unread set. */
export function toggleRead(entryId: EntryId): void {
  const entry = appState.entries.find((e) => e.id === entryId)
  if (!entry) return
  const next = entry.status === 'read' ? 'unread' : 'read'
  if (next === 'unread') {
    if (!appState.keepUnreadIds.includes(entryId)) appState.keepUnreadIds.push(entryId)
  } else {
    appState.keepUnreadIds = appState.keepUnreadIds.filter((id) => id !== entryId)
  }
  setLocalStatus(entryId, next)
}

/** Toggle list-view expansion; opening an entry is an explicit read. */
export function toggleExpanded(entryId: EntryId): void {
  const open = appState.expandedIds.includes(entryId)
  if (open) {
    appState.expandedIds = appState.expandedIds.filter((id) => id !== entryId)
    return
  }
  appState.expandedIds.push(entryId)
  autoRead(entryId, false, { ignoreFeedSetting: true, explicit: true })
}

/**
 * Single guarded entry point for auto-read — every trigger (scroll sweep,
 * j/k/buttons, card click) funnels here so the guard list is identical
 * regardless of how the read was provoked. `viaScroll` marks the passive scroll
 * trigger, which still requires the user to have actually scrolled; explicit
 * triggers (key/button/click) are deliberate by definition.
 */
export function autoRead(
  entryId: EntryId,
  viaScroll = false,
  opts: { ignoreFeedSetting?: boolean; explicit?: boolean } = {},
): void {
  // Never auto-read during a search — scrolling results shouldn't mark
  // matches read.
  if (appState.filter.search) return
  const entry = appState.entries.find((e) => e.id === entryId)
  if (!entry) return
  const prefs = appState.filter.feedId ? appState.feedPrefs[appState.filter.feedId] : undefined
  if (
    !shouldAutoRead({
      viewMode: appState.viewModeOverride ?? prefs?.viewMode ?? DEFAULT_VIEW_MODE,
      userHasScrolled: viaScroll ? appState.userHasScrolled : true,
      disabledAutoReadFeeds: (appState.userPrefs.disabledAutoReadFeeds ?? []) as FeedId[],
      keepUnreadIds: appState.keepUnreadIds,
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
export function moveAndRead(delta: 1 | -1): void {
  const ids = appState.entries.map((e) => e.id)
  if (ids.length === 0) return
  const currentIndex = appState.currentId ? ids.indexOf(appState.currentId) : -1
  const nextIndex =
    currentIndex === -1 ? (delta > 0 ? 0 : ids.length - 1) : clampNavIndex(currentIndex + delta, ids.length)
  const nextId = ids[nextIndex]!
  appState.currentId = nextId
  appState.navRequest = nextId
  autoRead(nextId, false, { explicit: true })
}

/** Shift+A / toolbar ✓: mark exactly the fetched display set read. */
export function markDisplayed(): void {
  const ids = appState.entries.filter((e) => e.status !== 'read').map((e) => e.id)
  for (const id of ids) setLocalStatus(id, 'read')
  void flushPending()
}

export function toggleStar(entryId: EntryId): void {
  const entry = appState.entries.find((e) => e.id === entryId)
  if (!entry) return
  const next = !entry.starred
  entry.starred = next
  void api.setStarred([entryId], next)
}

// ---- View prefs (per feed persisted; aggregates are session-only, matching
// the old store, whose global defaults were hardcoded) ----

function currentFeedId(): FeedId | null {
  return (appState.filter.feedId as FeedId | undefined) ?? null
}

export function setViewMode(viewMode: 'expanded' | 'list'): void {
  appState.viewModeOverride = viewMode
  const feedId = currentFeedId()
  if (feedId) {
    appState.feedPrefs[feedId] = { ...appState.feedPrefs[feedId], viewMode }
    void api.setFeedPrefs(feedId, { viewMode })
  }
}

export function setSort(sort: 'oldest' | 'newest'): void {
  appState.filter.sort = sort
  const feedId = currentFeedId()
  if (feedId) {
    appState.feedPrefs[feedId] = { ...appState.feedPrefs[feedId], sort }
    void api.setFeedPrefs(feedId, { sort })
  }
  void reloadEntries(appState.filter)
}

export function setHideReadItems(hideReadItems: boolean): void {
  appState.filter.hideReadItems = hideReadItems
  const feedId = currentFeedId()
  if (feedId) {
    appState.feedPrefs[feedId] = { ...appState.feedPrefs[feedId], hideReadItems }
    void api.setFeedPrefs(feedId, { hideReadItems })
  }
  void reloadEntries(appState.filter)
}

export function toggleHideEmptyFeeds(): void {
  const next = !(appState.userPrefs.hideEmptyFeeds === true)
  appState.userPrefs = { ...appState.userPrefs, hideEmptyFeeds: next }
  void api.setUserPrefs({ hideEmptyFeeds: next })
}

export function toggleAutoRead(feedId: FeedId): void {
  const list = appState.userPrefs.disabledAutoReadFeeds ?? []
  const next = list.includes(feedId) ? list.filter((f) => f !== feedId) : [...list, feedId]
  appState.userPrefs = { ...appState.userPrefs, disabledAutoReadFeeds: next }
  void api.setUserPrefs({ disabledAutoReadFeeds: next })
}

// ---- Icon fallback + rename editor ----

export function markIconFailed(feedId: FeedId): void {
  appState.iconFailed = { ...appState.iconFailed, [feedId]: true }
}

export function startRename(id: string, kind: 'feed' | 'category', title: string): void {
  appState.renameId = id
  appState.renameKind = kind
  appState.renameTitle = title
}

export function cancelRename(): void {
  appState.renameId = null
  appState.renameKind = null
  appState.renameTitle = ''
}

export async function saveRename(): Promise<void> {
  const id = appState.renameId
  const kind = appState.renameKind
  const title = appState.renameTitle.trim()
  if (id == null || kind == null || !title) return
  if (kind === 'feed') {
    await api.renameFeed(id as FeedId, title)
  } else {
    await api.renameCategory(id, title)
  }
  appState.panel = await api.panel()
  cancelRename()
}

export async function unsubscribe(feedId: FeedId): Promise<void> {
  await api.unsubscribe(feedId)
  appState.panel = await api.panel()
}

// ---- Idle refresh (old polling composable): counters every 60s, full panel
// every 10th tick, tail recheck when scrolled to the end. ----

const POLL_MS = 60_000
const PANEL_EVERY = 10
let pollTimer: ReturnType<typeof setInterval> | null = null
let pollTick = 0

export function startIdleRefresh(): () => void {
  if (pollTimer) return () => stopIdleRefresh()
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        appState.panel = await api.panel()
        pollTick++
        if (pollTick % PANEL_EVERY === 0) await loadEnd()
      } catch (err) {
        console.error('idle refresh failed', err)
      }
    })()
  }, POLL_MS)
  return () => stopIdleRefresh()
}

function stopIdleRefresh(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}
