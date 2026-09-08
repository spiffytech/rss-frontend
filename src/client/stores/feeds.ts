// Feeds store: sidebar state (feeds/categories/counters) + account-wide user
// prefs (hideEmptyFeeds, collapsedCats, disabledAutoReadFeeds) + rename editor
// + icon fallback. Composition-style, immutable updates. Counts are the server's
// truth via GET /counters (bootstrap, nav, bulk ops) plus local ±1 on single
// toggles.

import { ref } from 'vue'
import { defineStore } from 'pinia'

import { createMinifluxReaderApi } from '@/client/api/reader'
import type { MinifluxCategoryCount, MinifluxFeed } from '@/shared/types'

const api = createMinifluxReaderApi()

export const useFeedsStore = defineStore('feeds', () => {
  const feeds = ref<MinifluxFeed[]>([])
  const categories = ref<MinifluxCategoryCount[]>([])
  const counters = ref<Record<string, number>>({})

  // Account-wide user prefs (server-side, per account).
  const hideEmptyFeeds = ref(true)
  const collapsedCats = ref<Record<string, boolean>>({})
  const disabledAutoReadFeeds = ref<number[]>([])

  // Icon fallback: per-feed id -> true when the <img> errored.
  const iconFailed = ref<Record<number, boolean>>({})

  // Inline rename editor state.
  const renameId = ref<number | null>(null)
  const renameKind = ref<'feed' | 'category' | null>(null)
  const renameTitle = ref('')

  function applyPanel(panel: {
    feeds: MinifluxFeed[]
    categories: MinifluxCategoryCount[]
    counters: Record<string, number>
  }) {
    feeds.value = panel.feeds
    categories.value = panel.categories
    counters.value = panel.counters
    // Drop icon-failure flags for feeds that no longer exist.
    const ids = new Set(panel.feeds.map((f) => f.id))
    iconFailed.value = Object.fromEntries(
      Object.entries(iconFailed.value).filter(([id]) => ids.has(Number(id))),
    )
  }

  function applyFeedsCategories(panel: { feeds: MinifluxFeed[]; categories: MinifluxCategoryCount[] }) {
    feeds.value = panel.feeds
    categories.value = panel.categories
  }

  /** Replace just the unread counters (from GET /counters or bulk results). */
  function applyCounters(next: Record<string, number>) {
    counters.value = next
  }

  /** Idle-poll: refresh unread counters from the server; errors never throw. */
  async function refreshCounters() {
    try {
      applyCounters(await api.counters())
    } catch (err) {
      console.error('Failed to refresh sidebar counters', err)
    }
  }

  /** Idle-poll (slow): full panel snapshot so new/renamed feeds appear. */
  async function refreshPanel() {
    try {
      applyPanel(await api.panel())
    } catch (err) {
      console.error('Failed to refresh sidebar panel', err)
    }
  }

  /** Local ±1 on one feed's unread count (exact, from a known single toggle). */
  function adjustCounter(feedId: number, delta: -1 | 1) {
    const cur = (counters.value[feedId] ?? 0) + delta
    counters.value = { ...counters.value, [feedId]: Math.max(0, cur) }
  }

  function applyUserPrefs(prefs: {
    hideEmptyFeeds?: boolean
    collapsedCats?: Record<string, boolean>
    disabledAutoReadFeeds?: number[]
  }) {
    if (prefs.hideEmptyFeeds != null) hideEmptyFeeds.value = prefs.hideEmptyFeeds
    if (prefs.collapsedCats != null) collapsedCats.value = prefs.collapsedCats ?? {}
    if (prefs.disabledAutoReadFeeds != null) disabledAutoReadFeeds.value = prefs.disabledAutoReadFeeds
  }

  function markIconFailed(feedId: number) {
    iconFailed.value = { ...iconFailed.value, [feedId]: true }
  }

  // ---- Rename editor ----

  function startRename(id: number, kind: 'feed' | 'category', title: string) {
    renameId.value = id
    renameKind.value = kind
    renameTitle.value = title
  }

  function cancelRename() {
    renameId.value = null
    renameKind.value = null
    renameTitle.value = ''
  }

  async function saveRename() {
    const id = renameId.value
    const kind = renameKind.value
    const title = renameTitle.value.trim()
    if (id == null || kind == null || !title) return
    const panel =
      kind === 'feed'
        ? await api.renameFeed(id, title)
        : await api.renameCategory(id, title)
    applyFeedsCategories(panel)
    cancelRename()
  }

  // ---- Pref toggles (persist via 204 API; apply locally) ----

  async function toggleCollapsed(catId: number) {
    collapsedCats.value = { ...collapsedCats.value, [catId]: !collapsedCats.value[catId] }
    await api.setCollapsedCats(collapsedCats.value)
  }

  async function toggleHideEmptyFeeds() {
    hideEmptyFeeds.value = !hideEmptyFeeds.value
    await api.setHideEmptyFeeds(hideEmptyFeeds.value)
  }

  async function toggleAutoRead(feedId: number) {
    disabledAutoReadFeeds.value = disabledAutoReadFeeds.value.includes(feedId)
      ? disabledAutoReadFeeds.value.filter((f) => f !== feedId)
      : [...disabledAutoReadFeeds.value, feedId]
    await api.setAutoRead(disabledAutoReadFeeds.value)
  }

  return {
    feeds,
    categories,
    counters,
    hideEmptyFeeds,
    collapsedCats,
    disabledAutoReadFeeds,
    iconFailed,
    renameId,
    renameKind,
    renameTitle,
    applyPanel,
    applyFeedsCategories,
    applyCounters,
    refreshCounters,
    refreshPanel,
    adjustCounter,
    applyUserPrefs,
    markIconFailed,
    startRename,
    cancelRename,
    saveRename,
    toggleCollapsed,
    toggleHideEmptyFeeds,
    toggleAutoRead,
  }
})
