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
import { DEFAULT_HIDE_EMPTY_FEEDS,
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
  /** Every feed title the server has ever told us. The sidebar hides feeds with
   *  no unread items (`hideEmptyFeeds`), so without this a feed you have just
   *  finished reading drops out of `panel.feeds` and the header title degrades
   *  to its id. */
  feedTitles: {} as Record<FeedId, string>,
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
    applyPanel({ feeds: result.feeds, categories: result.categories, counters: result.counters })
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
    applyPanel(await api.panel((filter.feedId as FeedId | undefined) ?? null))
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

/** Apply a sidebar snapshot, remembering the titles it carries. Every panel
 *  assignment goes through here so the title cache cannot go stale-by-omission. */
function applyPanel(next: FeedPanelResult): void {
  appState.panel = next
  for (const feed of next.feeds) appState.feedTitles[feed.id] = feed.title
}

/** Identity filter change (URL navigation). */
export function setFilter(next: EntriesFilter): void {
  appState.filter = next
  resolveViewPrefs()
}

/** Scroll-sentinel page fetch: appends the next window (old infinite scroll). */
export async function loadMore(): Promise<void> {
  if (appState.loadingMore) return
  appState.loadingMore = true
  try {
    // A page that is entirely duplicates must not stall pagination (old spec:
    // the bulk-second window). Keep paging while a page yields nothing fresh,
    // bounded so a misbehaving server cannot loop us forever.
    for (let attempt = 0; attempt < 5; attempt++) {
      const cursor = appState.nextCursor
      if (!cursor) return
      const result = await api.entries(appState.filter, cursor)
      const seen = new Set(appState.entries.map((e) => e.id))
      const fresh = result.entries.filter((e) => !seen.has(e.id))
      if (fresh.length > 0) appState.entries.push(...fresh)
      appState.nextCursor = result.nextCursor
      if (fresh.length > 0 || !result.nextCursor) return
    }
  } finally {
    appState.loadingMore = false
  }
}

/**
 * End-of-list recheck (old checkTail): the window is exhausted, so ask the
 * server for anything beyond our loaded tail — items that arrived since the
 * view opened — and APPEND them in place (scroll preserved). If the server
 * says more remains, normal pagination resumes via the returned cursor.
 * Skipped for search views (their two-phase cursor can't be rebuilt from one
 * entry) and for newest sort (fresh items surface at the top; injecting at the
 * tail would trip the sweep and auto-read them unseen).
 */
export async function checkTail(): Promise<void> {
  if (appState.nextCursor || appState.loadingMore || appState.entries.length === 0) return
  if (appState.filter.search || appState.filter.sort === 'newest') return
  const tail = appState.entries[appState.entries.length - 1]!
  appState.loadingMore = true
  try {
    const result = await api.entries(appState.filter, { publishedAt: tail.publishedAt, id: tail.id })
    const seen = new Set(appState.entries.map((e) => e.id))
    const fresh = result.entries.filter((e) => !seen.has(e.id))
    if (fresh.length > 0) appState.entries.push(...fresh)
    appState.nextCursor = result.nextCursor
  } finally {
    appState.loadingMore = false
  }
}

/**
 * Refresh command (FeedMenu): ask the server to poll this view's feeds now —
 * the old app queued a Miniflux refresh and never waited either — then re-read
 * the view. New items land on the scheduler's next tick (≤60s) and surface
 * through the idle tail recheck.
 */
export async function refreshFeeds(): Promise<void> {
  await api.refresh(appState.filter)
  await reloadEntries(appState.filter)
}

// ---- Derived labels (old store's currentTitle / unreadCount) ----

export function currentTitle(): string {
  const filter = appState.filter
  if (filter.feedId != null && filter.feedId !== '') {
    // The sidebar hides feeds with no unread items, so the lookup can miss the
    // very feed being read; fall back to what we were told earlier, then to the
    // loaded entries' own feed title, and only then to the id.
    return (
      appState.panel.feeds.find((f) => f.id === filter.feedId)?.title ??
      appState.feedTitles[filter.feedId as FeedId] ??
      appState.entries.find((e) => e.feedId === filter.feedId)?.feedTitle ??
      `Feed ${filter.feedId}`
    )
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
  // Unselected (-1) clamps to the first entry for BOTH directions (old move()).
  const nextIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + delta))
  const nextId = ids[nextIndex]!
  appState.currentId = nextId
  appState.navRequest = nextId
  autoRead(nextId)
}

/** Shift+A / toolbar ✓: mark exactly the fetched display set read. */
export function markDisplayed(): void {
  const ids = appState.entries.filter((e) => e.status !== 'read').map((e) => e.id)
  for (const id of ids) setLocalStatus(id, 'read')
  void flushPending()
}

export async function toggleStar(entryId: EntryId): Promise<void> {
  const entry = appState.entries.find((e) => e.id === entryId)
  if (!entry) return
  const next = !entry.starred
  // Pessimistic (old behavior): the entry flips only once the server confirms.
  await api.setStarred([entryId], next)
  entry.starred = next
}

// ---- View prefs (per feed persisted; aggregates are session-only, matching
// the old store, whose global defaults were hardcoded) ----

function currentFeedId(): FeedId | null {
  return (appState.filter.feedId as FeedId | undefined) ?? null
}

/** The view mode in effect right now: a session override, else the current
 *  feed's saved pref, else the default. The menu toggle, its label, the `v` key
 *  and EntryItem all resolve through this — deriving the next mode from the raw
 *  override alone made the first toggle a no-op whenever no pref was saved. */
export function effectiveViewMode(): 'expanded' | 'list' {
  return (
    appState.viewModeOverride ??
    (appState.filter.feedId ? appState.feedPrefs[appState.filter.feedId as FeedId]?.viewMode : undefined) ??
    DEFAULT_VIEW_MODE
  )
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

export async function toggleHideEmptyFeeds(): Promise<void> {
  const next = !(appState.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS)
  try {
    await api.setUserPrefs({ hideEmptyFeeds: next })
  } catch {
    return // a failed persist leaves the row as it was (the old app awaited too)
  }
  appState.userPrefs = { ...appState.userPrefs, hideEmptyFeeds: next }
}

export async function toggleAutoRead(feedId: FeedId): Promise<void> {
  const list = appState.userPrefs.disabledAutoReadFeeds ?? []
  const next = list.includes(feedId) ? list.filter((f) => f !== feedId) : [...list, feedId]
  try {
    await api.setUserPrefs({ disabledAutoReadFeeds: next })
  } catch {
    return // idem: no silent flip when the write fails
  }
  appState.userPrefs = { ...appState.userPrefs, disabledAutoReadFeeds: next }
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
  applyPanel(await api.panel((appState.filter.feedId as FeedId | undefined) ?? null))
  cancelRename()
}

export async function unsubscribe(feedId: FeedId): Promise<void> {
  await api.unsubscribe(feedId)
  // No currentFeed: asking the panel to name the feed we just deleted is pointless.
  applyPanel(await api.panel(null))
}

// ---- Idle refresh (old polling composable): keep the sidebar honest while
// the page sits open, and extend the current view when items arrive at its
// tail. Tail semantics are the old ones — checked every poll AND on reaching
// the end, appended in place. One deliberate delta: the panel refreshes every
// poll rather than every 10th, because the old lean-counters tier existed to
// save Miniflux API round-trips and panel() is one local query here. ----

const POLL_MS = 60_000
let pollTimer: ReturnType<typeof setInterval> | null = null

export function startIdleRefresh(): () => void {
  if (pollTimer) return () => stopIdleRefresh()
  pollTimer = setInterval(() => {
    void (async () => {
      try {
        applyPanel(await api.panel((appState.filter.feedId as FeedId | undefined) ?? null))
        if (appState.atListEnd) await checkTail()
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
