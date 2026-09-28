<script setup lang="ts">
// TopToolbar — the reading view's header: sidebar toggle (mobile), brand
// (desktop), the feed menu, prev/next, and — on desktop only, where there is
// room — mark-all-read and the search box.
//
// Mobile deliberately has no search or ⋯ button: both actions live in the feed
// menu popover (see FeedMenu.vue), which leaves the header three touch targets
// wide instead of six.

import { useReaderStore } from '@/client/stores/reader'
import FeedMenu from '@/client/components/FeedMenu.vue'
import { useSearch } from '@/client/composables/search'

const reader = useReaderStore()
const { searchText, onSearchInput } = useSearch()

const emit = defineEmits<{ (e: 'toggleSidebar'): void }>()

async function onMarkAllRead() {
  await reader.markAllRead()
}
</script>

<template>
  <header class="flex flex-nowrap items-center gap-x-2 min-w-0 px-2 py-2 border-b-2 border-line mb-2">
    <!-- Mobile hamburger: toggles the sidebar drawer -->
    <button
      type="button"
      class="toolbar-btn md:hidden"
      title="Toggle feed list"
      aria-label="Toggle feed list"
      @click="emit('toggleSidebar')"
    >
      &#9776;
    </button>

    <a href="/" class="hidden md:inline shrink-0 font-semibold text-lg mr-auto">
      Miniflux Reader
    </a>

    <FeedMenu />

    <!-- Prev/next story: bare arrows on mobile so the feed name keeps its room;
         labels return as soon as there is space for them. -->
    <button
      type="button"
      class="toolbar-btn"
      title="Previous (k)"
      aria-label="Previous entry (k)"
      @click="reader.moveAndRead(-1)"
    >
      <span aria-hidden="true">▲</span><span class="hidden md:inline">&nbsp;Prev</span>
    </button>
    <button
      type="button"
      class="toolbar-btn"
      title="Next (j)"
      aria-label="Next entry (j)"
      @click="reader.moveAndRead(1)"
    >
      <span aria-hidden="true">▼</span><span class="hidden md:inline">&nbsp;Next</span>
    </button>

    <button
      type="button"
      class="toolbar-btn hidden md:inline-flex"
      title="Mark all read (Shift+A)"
      aria-label="Mark all read"
      @click="onMarkAllRead"
    >
      ✓
    </button>

    <input
      v-model="searchText"
      type="search"
      placeholder="Search…"
      class="hidden md:block flex-1 max-w-sm min-w-[100px] min-h-11 px-3 py-2 border border-line rounded-lg"
      @input="onSearchInput"
    />
  </header>
</template>