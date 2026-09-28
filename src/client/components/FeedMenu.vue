<script setup lang="ts">
// FeedMenu — the toolbar's "where am I" label turned into a menu: the current
// feed's name and unread count, plus a popover holding everything you can do to
// the current view. It replaces both the old mobile 🔍/⋯ buttons and the desktop
// ⋯ menu, so every action lives in one touch-sized list at every breakpoint.
//
// The panel is a top-layer `popover="auto"`, which buys light dismiss, Escape,
// focus restoration and immunity to ancestor overflow/clipping for free. The
// price is that a top-layer element's containing block is the viewport, so it
// does not follow the trigger: position comes from computePopoverPlacement()
// (src/shared/popover.ts), applied in `beforetoggle` — placing it after
// showPopover() would flash a frame of the UA's default centred position.
//
// Row styling follows Refactoring UI's action hierarchy: one primary (solid
// accent), secondary actions as lower-contrast fills with no border, and the
// destructive action demoted to that same secondary weight — the loud red is
// reserved for the confirm() step. Rows are always filled rather than filled on
// hover, because hover does not exist on a touchscreen and a row that only looks
// pressable under a mouse is not pressable at all.

import { computed, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAuthStore } from '@/client/stores/auth'
import { useFeedsStore } from '@/client/stores/feeds'
import { useReaderStore } from '@/client/stores/reader'
import { useMediaQuery } from '@/client/composables/media'
import { useSearch } from '@/client/composables/search'
import { computePopoverPlacement } from '@/shared/popover'

const PANEL_ID = 'feed-menu'

// A setting that is in its affirmative state (enabled, hidden) carries the accent
// fill. Note this follows the row's own value, not the underlying boolean: blue on
// "Auto-read: disabling" would read as a contradiction.
const TOGGLE_ON = 'bg-accent/15 hover:bg-accent/20 active:bg-accent/25'

const reader = useReaderStore()
const feeds = useFeedsStore()
const auth = useAuthStore()
const router = useRouter()
const isDesktop = useMediaQuery('(min-width: 48rem)')
const { searchText, onSearchInput, clearSearch } = useSearch()

const triggerEl = ref<HTMLButtonElement | null>(null)
const panelEl = ref<HTMLDivElement | null>(null)
const open = ref(false)

const feedId = computed(() => reader.filter.feedId)
// Rename/unsubscribe/sort/auto-read only mean something for one feed — Latest,
// Starred and category views are aggregates.
const isFeedView = computed(() => feedId.value != null && feedId.value !== '')
const searchActive = computed(() => Boolean(reader.filter.search))
const autoReadOff = computed(() =>
  feeds.disabledAutoReadFeeds.includes(Number(feedId.value)),
)

const markingAll = ref(false)
const renameOpen = ref(false)
const renameTitle = ref('')

// ---- Placement ----

/** Size and place the panel from the trigger's current rect. */
function place() {
  const trigger = triggerEl.value
  const panel = panelEl.value
  if (!trigger || !panel) return
  const { top, left, width, maxHeight } = computePopoverPlacement({
    rect: trigger.getBoundingClientRect(),
    viewportWidth: window.visualViewport?.width ?? window.innerWidth,
    viewportHeight: window.visualViewport?.height ?? window.innerHeight,
    isDesktop: isDesktop.value,
  })
  panel.style.top = `${top}px`
  panel.style.left = `${left}px`
  panel.style.width = `${width}px`
  panel.style.maxHeight = `${maxHeight}px`
}

// A window resize moves the trigger, but so can a layout change with no resize
// — typing in the search box adds the 🔍 chip to the trigger. The observer
// covers both, so the panel can't end up stranded behind the toolbar.
let triggerObserver: ResizeObserver | null = null

function watchTrigger() {
  window.addEventListener('resize', place)
  if (typeof ResizeObserver !== 'undefined' && triggerEl.value) {
    triggerObserver = new ResizeObserver(place)
    triggerObserver.observe(triggerEl.value)
  }
}

function unwatchTrigger() {
  window.removeEventListener('resize', place)
  triggerObserver?.disconnect()
  triggerObserver = null
}

onUnmounted(unwatchTrigger)

/**
 * Open the modal, placing it before showModal() so it can never paint a frame in
 * the UA's centred default position. showModal() is the native feature doing the
 * work here: it makes the rest of the document inert AND gives us the dimming
 * ::backdrop, neither of which popover="auto" provides.
 */
function openPanel() {
  const panel = panelEl.value
  if (!panel || panel.open) return
  place()
  panel.showModal()
  open.value = true
  watchTrigger()
}

/** Also fires for Escape, so this is the single teardown point. */
function onClose() {
  open.value = false
  unwatchTrigger()
  renameOpen.value = false
}

/**
 * A click whose target is the dialog itself landed on the backdrop — the classic
 * tap-outside-to-dismiss. Nothing behind the backdrop is reachable anyway: a
 * modal makes the rest of the document inert, so only the backdrop takes a tap.
 */
function onPanelClick(evt: MouseEvent) {
  if (evt.target === panelEl.value) closePanel()
}

/** A dialog is open exactly while its own `open` property is set. */
function isPanelOpen(): boolean {
  return panelEl.value?.open ?? false
}

/** Close after an action — the backdrop only covers taps outside the panel. */
function closePanel() {
  if (isPanelOpen()) panelEl.value?.close()
}

/** Every row dismisses the panel, so the action runner owns that. */
async function runAndClose(action: () => Promise<unknown> | unknown) {
  try {
    await action()
  } finally {
    closePanel()
  }
}

// ---- Actions ----

async function onMarkAllRead() {
  if (markingAll.value) return
  markingAll.value = true
  try {
    await reader.markAllRead()
  } finally {
    markingAll.value = false
    closePanel()
  }
}

const onRefresh = () => runAndClose(() => reader.refresh())

const onViewMode = () =>
  runAndClose(() => reader.setViewMode(reader.viewMode === 'expanded' ? 'list' : 'expanded'))

const onSort = () =>
  runAndClose(() => reader.setSort(reader.sort === 'newest' ? 'oldest' : 'newest'))

const onToggleAutoRead = () => runAndClose(() => feeds.toggleAutoRead(Number(feedId.value)))

const onHideEmptyFeeds = () => runAndClose(() => feeds.toggleHideEmptyFeeds())

const onHideReadItems = () => runAndClose(() => reader.setHideReadItems(!reader.hideReadItems))

const onClearSearch = () => runAndClose(() => clearSearch())

function startRename() {
  renameTitle.value = reader.currentTitle
  renameOpen.value = true
}

function cancelRename() {
  renameOpen.value = false
  renameTitle.value = ''
}

async function saveRename() {
  const id = Number(feedId.value)
  const title = renameTitle.value.trim()
  if (!Number.isInteger(id) || !title) return
  await feeds.renameFeed(id, title)
  renameOpen.value = false
  closePanel()
}

function onRenameKeydown(evt: KeyboardEvent) {
  if (evt.key !== 'Escape') return
  // Escape is also the popover's dismiss key. Claim it while the rename field is
  // what's being escaped; if a browser still closes the panel, the toggle
  // handler cancels the rename anyway, so the worst case is a coarser escape.
  evt.preventDefault()
  evt.stopPropagation()
  cancelRename()
}

async function onUnsubscribe() {
  const id = feedId.value
  if (id == null || id === '') return
  if (!confirm('Unsubscribe from this feed?')) return
  await reader.unsubscribe(Number(id))
  closePanel()
  router.push({ name: 'reader' })
}

async function onLogout() {
  await auth.logout()
  closePanel()
  router.push({ name: 'login' })
}
</script>

<template>
  <div class="min-w-0 flex-1 md:flex-none md:mr-auto">
    <button
      ref="triggerEl"
      type="button"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="PANEL_ID"
      data-testid="feed-menu-trigger"
      class="w-full md:w-auto min-h-11 min-w-0 flex items-center gap-x-2 px-3 py-2 border border-line rounded-lg bg-white hover:bg-surface active:bg-line leading-none text-left"
      @click="openPanel"
    >
      <span class="min-w-0 flex-1 truncate font-medium">{{ reader.currentTitle }}</span>
      <span
        v-if="reader.unreadCount != null"
        data-testid="feed-menu-count"
        class="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
      >
        {{ reader.unreadCount }}
      </span>
      <span
        v-if="searchActive"
        class="shrink-0 max-w-24 truncate text-xs text-muted"
        :title="reader.filter.search"
      >
        &#128269; {{ reader.filter.search }}
      </span>
      <span class="shrink-0 text-xs text-muted" aria-hidden="true">&#9662;</span>
    </button>

    <dialog
      :id="PANEL_ID"
      ref="panelEl"
      tabindex="-1"
      aria-label="Feed actions and settings"
      class="inset-auto m-0 max-w-none max-h-none bg-white border border-line rounded-xl shadow-xl text-sm overflow-y-auto overscroll-contain backdrop:bg-black/40"
      @click="onPanelClick"
      @close="onClose"
    >
      <form
        v-if="renameOpen"
        class="p-3 flex flex-col gap-2"
        @submit.prevent="saveRename"
      >
        <label for="feed-rename" class="text-xs font-semibold uppercase tracking-wide text-muted">
          Rename feed
        </label>
        <input
          id="feed-rename"
          v-model="renameTitle"
          v-focus
          type="text"
          class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
          @keydown="onRenameKeydown"
        />
        <div class="flex gap-2">
          <button
            type="submit"
            class="flex-1 min-h-11 rounded-lg bg-accent text-white font-medium cursor-pointer hover:brightness-95 active:brightness-90"
          >
            Save
          </button>
          <button
            type="button"
            class="flex-1 min-h-11 rounded-lg bg-gray-50 text-ink cursor-pointer hover:bg-gray-100 active:bg-gray-200"
            @click="cancelRename"
          >
            Cancel
          </button>
        </div>
      </form>

      <div v-else class="flex flex-col">
        <!-- Search: the only one on mobile, since the toolbar box is desktop
             only. "Clear search" lives with it and is equally hidden on desktop,
             where the toolbar box itself is the way to clear. -->
        <div class="md:hidden p-2 flex flex-col gap-1 border-b border-line">
          <input
            v-model="searchText"
            type="search"
            placeholder="Search…"
            class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
            @input="onSearchInput"
          />
          <button v-if="searchActive" type="button" class="menu-row" @click="onClearSearch">
            Clear search
          </button>
        </div>

        <!-- The one primary action on this surface. -->
        <div class="p-2 border-b border-line">
          <button
            type="button"
            class="w-full min-h-12 flex items-center justify-center gap-x-2 rounded-lg bg-accent text-white font-semibold cursor-pointer hover:brightness-95 active:brightness-90 disabled:opacity-60"
            :disabled="markingAll"
            @click="onMarkAllRead"
          >
            <span aria-hidden="true">&#10003;</span>
            <span>{{ markingAll ? 'Marking…' : 'Mark all read' }}</span>
          </button>
        </div>

        <!-- Every setting in one group, each reading as name: value, laid out in
             the same two-up grid as the commands below. The count is odd (five in
             a feed view, three in an aggregate), so the last row has a spare
             cell; it is left empty rather than stretched, which keeps every
             button the same width. -->
        <div class="p-2 grid grid-cols-2 gap-1 border-b border-line">
          <button type="button" class="menu-row" @click="onViewMode">
            View: {{ reader.viewMode === 'expanded' ? 'expanded' : 'list' }}
          </button>
          <button v-if="isFeedView" type="button" class="menu-row" @click="onSort">
            Sort: {{ reader.sort === 'oldest' ? 'oldest first' : 'newest first' }}
          </button>
          <button
            v-if="isFeedView"
            type="button"
            class="menu-row"
            :class="autoReadOff ? '' : TOGGLE_ON"
            :aria-pressed="autoReadOff"
            @click="onToggleAutoRead"
          >
            Auto-read: {{ autoReadOff ? 'disabled' : 'enabled' }}
          </button>
          <button
            type="button"
            class="menu-row"
            :class="feeds.hideEmptyFeeds ? TOGGLE_ON : ''"
            :aria-pressed="feeds.hideEmptyFeeds"
            @click="onHideEmptyFeeds"
          >
            Empty feeds: {{ feeds.hideEmptyFeeds ? 'hidden' : 'shown' }}
          </button>
          <button
            type="button"
            class="menu-row"
            :class="reader.hideReadItems ? TOGGLE_ON : ''"
            :aria-pressed="reader.hideReadItems"
            @click="onHideReadItems"
          >
            Read items: {{ reader.hideReadItems ? 'hidden' : 'shown' }}
          </button>
        </div>

        <!-- Commands, in a two-up grid: always an even count (four in a feed view,
             two in an aggregate), so no cell is ever left half-empty. The two
             "leave" actions pair on the last row. -->
        <div class="p-2 grid grid-cols-2 gap-1">
          <button type="button" class="menu-row" @click="onRefresh">Refresh feeds</button>
          <button v-if="isFeedView" type="button" class="menu-row" @click="startRename">
            Rename feed…
          </button>
          <button
            v-if="isFeedView"
            type="button"
            class="menu-row text-red-600"
            @click="onUnsubscribe"
          >
            Unsubscribe
          </button>
          <button type="button" class="menu-row" @click="onLogout">Sign out</button>
        </div>
      </div>
    </dialog>
  </div>
</template>