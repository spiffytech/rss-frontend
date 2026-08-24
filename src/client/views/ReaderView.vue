<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'

import TopToolbar from '@/client/components/TopToolbar.vue'
import FeedPanel from '@/client/components/FeedPanel.vue'
import EntryList from '@/client/components/EntryList.vue'
import { useReaderStore } from '@/client/stores/reader'
import { useKeyboard } from '@/client/composables/keyboard'
import { useSidebarResize } from '@/client/composables/resize'
import { useMediaQuery } from '@/client/composables/media'
import { scrollToEntry } from '@/client/composables/nav'
import { parseFilterFromUrl } from '@/shared/filter'

const route = useRoute()
const reader = useReaderStore()

useKeyboard()
useSidebarResize()

const isDesktop = useMediaQuery('(min-width: 48rem)')
const sidebarOpen = ref(false)

// Identity filter comes from the URL query string (feed/category/starred/
// search). View prefs (view/sort/hideReadItems) are resolved from the
// hydrated feedPrefs map, not re-fetched per nav.
const filter = parseFilterFromUrl(route.query as Record<string, string | null>)
reader.setFilter(filter)

// Bootstrap exactly once per page load (prefs for all feeds + panel + page 1);
// navigation only fetches entries + counters (see loadView in ReaderView).
onMounted(() => {
  reader.load()
})

watch(
  () => route.query,
  () => {
    // A feed/category/section link in the drawer navigates via router — the
    // old app did a full page load (which reset the drawer); the SPA must
    // close it explicitly.
    sidebarOpen.value = false

    const next = parseFilterFromUrl(route.query as Record<string, string | null>)
    // Only reload when the identity filter actually changed.
    if (
      next.feedId !== reader.filter.feedId ||
      next.categoryId !== reader.filter.categoryId ||
      next.starred !== reader.filter.starred ||
      next.search !== reader.filter.search
    ) {
      reader.setFilter(next)
      // Jump to the top of the new feed — a page load used to do this for
      // free; the SPA keeps the scroll container alive across nav.
      resetScrollTop()
      reader.loadView()
    }
  },
)

// Reset the reading scroll container to the top (new feed/page load parity).
const scrollEl = ref<HTMLElement | null>(null)
function resetScrollTop() {
  if (scrollEl.value) scrollEl.value.scrollTop = 0
}

// Scroll-into-view watcher for nav: one DOM effect for the whole app.
// navigation is a state transition; only the actual scroll is geometry.
watch(
  () => reader.navRequest,
  (id) => {
    if (id != null) {
      scrollToEntry(id)
      reader.navRequest = null
    }
  },
)

// Mark userHasScrolled on the entry-list scroll container.
function onListScroll() {
  reader.userHasScrolled = true
}
</script>

<template>
  <div class="grid grid-rows-[auto_1fr] app-container flex-1 min-h-0">
    <TopToolbar />

    <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
      <!-- Sidebar: static column on md+, off-canvas drawer on mobile toggled
           by v-show. The drawer is hidden until opened; on desktop it
           renders as a static column. -->
      <div
        class="app-sidebar fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto"
        :class="{ hidden: !sidebarOpen && !isDesktop }"
      >
        <div class="flex justify-end md:hidden p-2">
          <button type="button" class="px-2 py-2 border border-gray-300 rounded-md" @click="sidebarOpen = false">
            ✕
          </button>
        </div>
        <FeedPanel />
      </div>

      <!-- Scrim on mobile while the drawer is open. -->
      <div
        v-if="sidebarOpen && !isDesktop"
        class="fixed inset-0 z-20 bg-black/30 md:hidden"
        @click="sidebarOpen = false"
      ></div>

      <!-- Drag-to-resize handle (desktop only): sits in the grid gap. -->
      <div
        id="sidebar-resize"
        class="absolute top-0 bottom-0 z-40 hidden md:block cursor-col-resize touch-none hover:bg-cyan-700/20"
        :style="{ left: 'calc(var(--sidebar-w) + 3px)', width: '6px' }"
        aria-hidden="true"
      ></div>

      <div ref="scrollEl" class="overflow-y-auto min-h-0" data-testid="entry-scroll" @scroll="onListScroll">
        <EntryList />
      </div>
    </div>
  </div>
</template>
