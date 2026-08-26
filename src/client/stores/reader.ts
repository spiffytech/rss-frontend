// Reader store: the current view's state — filter, entries, pagination,
// currentId (which entry owns the top), keyboard nav, and the per-feed view
// prefs resolved from the feedPrefs map hydrated at bootstrap. Composition-
// style, immutable updates.

import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

import { createMinifluxReaderApi } from '@/client/api/reader'
import { useFeedsStore } from '@/client/stores/feeds'
import type { EntriesFilter } from '@/shared/filter'
import type { FeedPrefs, MinifluxEntry } from '@/shared/types'

const api = createMinifluxReaderApi()

export const useReaderStore = defineStore('reader', () => {
  const feeds = useFeedsStore()

  // ---- Identity filter (from URL) + effective per-feed view prefs ----
  const filter = ref<EntriesFilter>({ status: 'unread' })
  const feedPrefs = ref<Record<number, FeedPrefs>>({})
  const viewMode = ref<'expanded' | 'list'>('expanded')
  const sort = ref<'oldest' | 'newest'>('oldest')
  const hideReadItems = ref(true)

  // ---- Entries + pagination ----
  const entries = ref<MinifluxEntry[]>([])
  const seenIds = ref(new Set<number>())
  const nextCursor = ref<string | null>(null)
  const hasMore = ref(false)
  const loadingMore = ref(false)

  // ---- Reading anchor: which entry is at the top of the viewport ----
  const currentId = ref(0)
  // Transient target for the scroll-into-view watcher. Self-clears so a nav
  // request can't re-trigger, and the scroll watcher never writes currentId,
  // so user scroll → currentId patch → no scrollIntoView loop.
  const navRequest = ref<number | null>(null)
  // Client-only set of reader-session state (never crosses the API).
  const keepUnreadIds = ref(new Set<number>())
  const userHasScrolled = ref(false)
  // Bumped on every full list replacement (applyPage). v-track-top reads it to
  // re-arm its "skip the first observe" init guard per page, so navigating to a
  // new feed leaves the list unselected (currentId stays 0) exactly like a
  // fresh page load — instead of inheriting the previous feed's selection.
  const pageGen = ref(0)
  // True while the entry-list scroll container sits within ~200px of its bottom
  // (set by ReaderView's scroll handler). Gates the idle-time tail recheck.
  const atListEnd = ref(false)

  const entryIds = computed(() => entries.value.map((e) => e.id))

  const currentTitle = computed(() => {
    if (filter.value.feedId != null && filter.value.feedId !== '') {
      return (
        feeds.feeds.find((f) => f.id === Number(filter.value.feedId))?.title ??
        `Feed ${filter.value.feedId}`
      )
    }
    if (filter.value.starred) return 'Starred'
    return 'Latest'
  })

  // Unread count for the current filter, computed client-side from the
  // served counters (null when not meaningful, e.g. Starred).
  const unreadCount = computed(() => {
    if (filter.value.feedId != null && filter.value.feedId !== '') {
      return feeds.counters[Number(filter.value.feedId)] ?? 0
    }
    if (filter.value.starred) return null
    if (filter.value.categoryId != null && filter.value.categoryId !== '') {
      const catId = Number(filter.value.categoryId)
      return feeds.feeds
        .filter((f) => f.category?.id === catId)
        .reduce((sum, f) => sum + (feeds.counters[f.id] ?? 0), 0)
    }
    return Object.values(feeds.counters).reduce((a, b) => a + b, 0)
  })

  /** Resolve effective view prefs for the current feed from the shipped map. */
  function resolveViewPrefs() {
    const feedId = Number(filter.value.feedId)
    const p = Number.isInteger(feedId) && feedId > 0 ? feedPrefs.value[feedId] : undefined
    viewMode.value = p?.viewMode ?? 'expanded'
    sort.value = p?.sort ?? 'oldest'
    hideReadItems.value = p?.hideReadItems ?? true
  }

  /** Replace the identity filter (from URL) and resolve view prefs. */
  function setFilter(next: EntriesFilter) {
    filter.value = next
    resolveViewPrefs()
  }

  // ---- Page application ----

  function applyPage(result: { entries: MinifluxEntry[]; nextCursor: string | null; hasMore: boolean }) {
    entries.value = result.entries
    seenIds.value = new Set(result.entries.map((e) => e.id))
    nextCursor.value = result.nextCursor
    hasMore.value = result.hasMore
    currentId.value = 0
    navRequest.value = null
    userHasScrolled.value = false
    atListEnd.value = false
    pageGen.value++
  }

  // ---- Load (bootstrap once per page load; nav = entries only) ----

  async function load() {
    const result = await api.bootstrap(filter.value)
    feedPrefs.value = result.feedPrefs
    feeds.applyPanel(result)
    feeds.applyUserPrefs(result.userPrefs)
    resolveViewPrefs()
    applyPage(result)
    return result
  }

  async function loadView() {
    // Persist any pending optimistic read/unread before replacing entries with
    // server truth, so a quick nav doesn't drop the marks.
    await flushPending()
    const filterForPage: EntriesFilter = {
      ...filter.value,
      sort: sort.value,
      hideReadItems: hideReadItems.value,
    }
    const page = await api.entries(filterForPage)
    applyPage(page)
    // Counts stay honest: lean counters refresh on nav.
    const counters = await api.counters()
    feeds.applyCounters(counters)
  }

  async function loadMore() {
    if (loadingMore.value || !hasMore.value || nextCursor.value == null) return
    loadingMore.value = true
    try {
      const filterForPage: EntriesFilter = {
        ...filter.value,
        sort: sort.value,
        hideReadItems: hideReadItems.value,
      }
      const result = await api.entries(filterForPage, nextCursor.value)
      // Dedupe by id: the inclusive ±1s window may re-serve entries sharing the
      // pivot's second. The cursor's skip count guarantees the SERVER advances
      // every page regardless, so a fully-duplicate page is no longer a reason
      // to stop — adopt cursor/hasMore unconditionally and keep scrolling.
      const fresh = result.entries.filter((e) => !seenIds.value.has(e.id))
      for (const e of fresh) seenIds.value.add(e.id)
      if (fresh.length > 0) entries.value = [...entries.value, ...fresh]
      nextCursor.value = result.nextCursor
      hasMore.value = result.hasMore
    } finally {
      loadingMore.value = false
    }
  }

  // ---- Single-entry mutations ----
  //
  // Read/unread are OPTIMISTIC + BATCHED: we apply the status change to the
  // local entry (and adjust the unread counter) immediately, then accumulate the
  // id into a pending batch that is flushed to the server on a short debounce.
  // Fast scrolling therefore collapses many auto-reads into one HTTP round-trip
  // instead of a request per entry. Star stays pessimistic (server truth).

  const BATCH_MS = 300
  const pendingStatus = ref(new Map<number, 'read' | 'unread'>())
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  function enqueueStatus(id: number, status: 'read' | 'unread') {
    pendingStatus.value.set(id, status)
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flushPending(), BATCH_MS)
  }

  async function flushPending() {
    flushTimer = null
    if (pendingStatus.value.size === 0) return
    const map = pendingStatus.value
    pendingStatus.value = new Map()
    const reads: number[] = []
    const unreads: number[] = []
    for (const [id, status] of map) {
      if (status === 'read') reads.push(id)
      else unreads.push(id)
    }
    try {
      if (reads.length) await api.setStatus(reads, 'read')
      if (unreads.length) await api.setStatus(unreads, 'unread')
    } catch (err) {
      console.error('Failed to persist read/unread batch', err)
    }
  }

  /** Apply a status change to the local entry + counter, optimistic. */
  function applyStatusOptimistically(id: number, status: 'read' | 'unread') {
    const entry = entries.value.find((e) => e.id === id)
    if (!entry || entry.status === status) return
    entries.value = entries.value.map((e) => (e.id === id ? { ...e, status } : e))
    seenIds.value.add(id)
    feeds.adjustCounter(entry.feed_id, status === 'unread' ? 1 : -1)
    enqueueStatus(id, status)
  }

  /** Toggle the read/unread state of an entry (m key / keep-unread button). */
  async function toggleRead(id: number) {
    const entry = entries.value.find((e) => e.id === id)
    const next: 'read' | 'unread' = entry?.status === 'read' ? 'unread' : 'read'
    applyStatusOptimistically(id, next)
    if (next === 'unread') keepUnreadIds.value.add(id)
    else keepUnreadIds.value.delete(id)
  }

  /** Auto-read an entry as it enters the reading band. Optimistic. */
  async function autoRead(id: number) {
    // Never auto-read during a search — scrolling/reading search results
    // shouldn't mark matches read.
    if (filter.value.search) return
    const entry = entries.value.find((e) => e.id === id)
    if (!entry || entry.status === 'read') return
    // The upstream directive guards via shouldAutoRead, but j/k/arrows call us
    // directly — preserve the old server-side disabled-feeds check here.
    if (feeds.disabledAutoReadFeeds.includes(entry.feed_id)) return
    applyStatusOptimistically(id, 'read')
  }

  /** Star/bookmark toggle stays pessimistic: apply only on server truth. */
  async function star(id: number) {
    const { entry } = await api.star(id)
    replaceEntry(entry)
    return entry
  }

  function replaceEntry(entry: MinifluxEntry) {
    entries.value = entries.value.map((e) => (e.id === entry.id ? entry : e))
    seenIds.value.add(entry.id)
  }

  // ---- List-level mutations ----

  /**
   * End-of-list recheck: ask the server directly whether entries exist beyond
   * our loaded tail — items that arrived since the feed was opened, or ones
   * local counters can't vouch for. Appends whatever is genuinely new and
   * resumes normal pagination if the server says more remains. Skipped for
   * search views: their two-phase cursor can't be rebuilt from one entry.
   */
  const checkingTail = ref(false)

  async function checkTail() {
    if (checkingTail.value || loadingMore.value || hasMore.value) return
    if (filter.value.search) return
    const last = entries.value[entries.value.length - 1]
    if (!last) return
    checkingTail.value = true
    try {
      // Persist pending read/unread first so the server filters with current truth.
      await flushPending()
      const filterForPage: EntriesFilter = {
        ...filter.value,
        sort: sort.value,
        hideReadItems: hideReadItems.value,
      }
      // Fresh window anchored at the tail entry's second with skip=1: serves
      // unseen same-second siblings plus everything beyond it in sort order.
      const result = await api.entries(filterForPage, `${last.published_at}~1`)
      const fresh = result.entries.filter((e) => !seenIds.value.has(e.id))
      for (const e of fresh) seenIds.value.add(e.id)
      if (fresh.length > 0) entries.value = [...entries.value, ...fresh]
      if (result.hasMore && result.nextCursor != null) {
        nextCursor.value = result.nextCursor
        hasMore.value = true
      }
    } finally {
      checkingTail.value = false
    }
  }

  async function markAllRead() {
    await flushPending()
    const result = await api.markAllRead({
      ...filter.value,
      sort: sort.value,
      hideReadItems: hideReadItems.value,
    })
    // One-call: fresh page 1 + counters; no client entryIds.
    feeds.applyCounters(result.counters)
    applyPage(result)
    return result
  }

  async function refresh() {
    await flushPending()
    const result = await api.refresh({
      ...filter.value,
      sort: sort.value,
      hideReadItems: hideReadItems.value,
    })
    feeds.applyPanel(result)
    applyPage(result)
    return result
  }

  async function unsubscribe(feedId: number) {
    await api.unsubscribe(feedId)
  }

  // ---- Per-feed view prefs (persist via 204; refetch only when ordering/
  // membership is server-determined) ----

  function currentFeedId(): number | undefined {
    const feedId = Number(filter.value.feedId)
    return Number.isInteger(feedId) && feedId > 0 ? feedId : undefined
  }

  async function setViewMode(mode: 'expanded' | 'list') {
    viewMode.value = mode
    await api.setViewMode(currentFeedId(), mode)
    const feedId = currentFeedId()
    if (feedId != null) feedPrefs.value = { ...feedPrefs.value, [feedId]: { ...feedPrefs.value[feedId], viewMode: mode } }
  }

  async function setSort(mode: 'oldest' | 'newest') {
    sort.value = mode
    await api.setSort(currentFeedId(), mode)
    const feedId = currentFeedId()
    if (feedId != null) feedPrefs.value = { ...feedPrefs.value, [feedId]: { ...feedPrefs.value[feedId], sort: mode } }
    await loadView()
  }

  async function setHideReadItems(hide: boolean) {
    hideReadItems.value = hide
    await api.setHideReadItems(currentFeedId(), hide)
    const feedId = currentFeedId()
    if (feedId != null) feedPrefs.value = { ...feedPrefs.value, [feedId]: { ...feedPrefs.value[feedId], hideReadItems: hide } }
    await loadView()
  }

  // ---- Keyboard nav (j/k/arrows) ----

  /** Move the reading anchor by delta; returns the new currentId (0 when none). */
  function move(delta: number): number {
    const ids = entryIds.value
    const i = ids.indexOf(currentId.value)
    const next = ids[Math.max(0, Math.min(ids.length - 1, i + delta))]
    if (next != null) {
      currentId.value = next
      navRequest.value = next
      return next
    }
    return 0
  }

  return {
    filter,
    feedPrefs,
    viewMode,
    sort,
    hideReadItems,
    entries,
    seenIds,
    nextCursor,
    hasMore,
    loadingMore,
    currentId,
    navRequest,
    keepUnreadIds,
    userHasScrolled,
    pageGen,
    atListEnd,
    entryIds,
    unreadCount,
    currentTitle,
    setFilter,
    load,
    loadView,
    loadMore,
    checkTail,
    toggleRead,
    star,
    autoRead,
    markAllRead,
    refresh,
    unsubscribe,
    setViewMode,
    setSort,
    setHideReadItems,
    move,
  }
})
