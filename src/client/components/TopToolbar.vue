<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'

import { useReaderStore } from '@/client/stores/reader'
import { useFeedsStore } from '@/client/stores/feeds'
import { useAuthStore } from '@/client/stores/auth'

const reader = useReaderStore()
const feeds = useFeedsStore()
const auth = useAuthStore()
const router = useRouter()

const emit = defineEmits<{ (e: 'toggleSidebar'): void }>()

const menuOpen = ref(false)
const searchOpen = ref(false)
const searchText = ref('')
let searchTimer: ReturnType<typeof setTimeout> | undefined

const feedId = reader.filter.feedId

// Outside-click closes the menu (mirrors the old datastar __outside).
const menuEl = ref<HTMLElement | null>(null)
function onDocClick(e: MouseEvent) {
  if (menuEl.value && !menuEl.value.contains(e.target as Node)) {
    menuOpen.value = false
  }
}
onMounted(() => document.addEventListener('click', onDocClick))
onUnmounted(() => document.removeEventListener('click', onDocClick))

async function onViewMode() {
  await reader.setViewMode(reader.viewMode === 'expanded' ? 'list' : 'expanded')
  menuOpen.value = false
}

async function onSort() {
  await reader.setSort(reader.sort === 'newest' ? 'oldest' : 'newest')
  menuOpen.value = false
}

async function onToggleAutoRead() {
  if (feedId != null && feedId !== '') {
    await feeds.toggleAutoRead(Number(feedId))
  }
  menuOpen.value = false
}

async function onHideReadItems() {
  await reader.setHideReadItems(!reader.hideReadItems)
  menuOpen.value = false
}

async function onMarkAllRead() {
  await reader.markAllRead()
  menuOpen.value = false
}

async function onRefresh() {
  await reader.refresh()
  menuOpen.value = false
}

async function onUnsubscribe() {
  if (feedId == null || feedId === '') return
  if (!confirm('Unsubscribe from this feed?')) return
  await reader.unsubscribe(Number(feedId))
  menuOpen.value = false
  router.push({ name: 'reader' })
}

async function onLogout() {
  await auth.logout()
  router.push({ name: 'login' })
}

function onSearchInput() {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    reader.setFilter({ ...reader.filter, search: searchText.value || undefined })
    reader.load()
  }, 300)
}
</script>

<template>
  <header class="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 border-b-2 border-gray-300 mb-2">
    <!-- Mobile hamburger: toggles the sidebar drawer -->
    <button
      type="button"
      class="md:hidden px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Toggle feed list"
      @click="emit('toggleSidebar')"
    >
      ☰
    </button>

    <a href="/" class="hidden md:inline font-semibold text-lg mr-auto">
      Miniflux Reader
    </a>

    <span class="text-sm text-gray-500 min-w-0 flex-1 truncate md:flex-none md:mr-auto">
      <span>{{ reader.currentTitle }}</span>
      <span v-if="reader.unreadCount != null" class="text-xs text-gray-400">
        ({{ reader.unreadCount }})
      </span>
    </span>

    <!-- Mobile: search icon expands a search field -->
    <button
      type="button"
      class="md:hidden px-2 py-2 border border-gray-300 rounded-md leading-none"
      title="Search"
      :aria-expanded="searchOpen"
      @click="searchOpen = !searchOpen"
    >
      🔍
    </button>
    <input
      v-if="searchOpen"
      v-model="searchText"
      type="search"
      placeholder="Search…"
      class="md:hidden w-full p-2 border border-gray-300 rounded-md"
      @input="onSearchInput"
    />

    <!-- Prev / next story -->
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none order-2 md:order-none"
      title="Previous (k)"
      aria-label="Previous entry (k)"
      @click="reader.move(-1); if (reader.currentId) reader.autoRead(reader.currentId)"
    >
      ▲ Prev
    </button>
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none order-3 md:order-none"
      title="Next (j)"
      aria-label="Next entry (j)"
      @click="reader.move(1); if (reader.currentId) reader.autoRead(reader.currentId)"
    >
      Next ▼
    </button>
    <button
      type="button"
      class="hidden md:block px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Mark all read (Shift+A)"
      @click="onMarkAllRead"
    >
      ✓
    </button>

    <input
      v-model="searchText"
      type="search"
      placeholder="Search…"
      class="hidden md:block flex-1 max-w-sm min-w-[100px] p-2 border border-gray-300 rounded-md"
      @input="onSearchInput"
    />

    <!-- View options menu -->
    <div ref="menuEl" class="relative ml-auto order-1 md:order-none">
      <button
        type="button"
        class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
        title="View options"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click.stop="menuOpen = !menuOpen"
      >
        ⋯
      </button>
      <div
        v-if="menuOpen"
        class="absolute right-0 mt-1 w-56 max-w-[calc(100vw-1rem)] bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1 text-sm"
      >
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 block"
          @click="onViewMode"
        >
          {{ reader.viewMode === 'expanded' ? 'List view' : 'Expanded view' }}
        </button>
        <button
          v-if="feedId != null && feedId !== ''"
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 block"
          @click="onSort"
        >
          {{ reader.sort === 'newest' ? 'Newest first' : 'Oldest first' }}
        </button>
        <button
          v-if="feedId != null && feedId !== ''"
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
          @click="onToggleAutoRead"
        >
          <span class="w-4 inline-block">{{ feeds.disabledAutoReadFeeds.includes(Number(feedId)) ? '✓' : '' }}</span>
          Disable auto-read
        </button>
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
          @click="feeds.toggleHideEmptyFeeds(); menuOpen = false"
        >
          <span class="w-4 inline-block">{{ feeds.hideEmptyFeeds ? '✓' : '' }}</span>
          Hide empty feeds
        </button>
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
          @click="onHideReadItems"
        >
          <span class="w-4 inline-block">{{ reader.hideReadItems ? '✓' : '' }}</span>
          Hide read items
        </button>
        <div class="my-1 border-t border-gray-200" aria-hidden="true"></div>
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100"
          @click="onMarkAllRead"
        >
          Mark all read
        </button>
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100"
          @click="onRefresh"
        >
          Refresh feeds
        </button>
        <div class="my-1 border-t border-gray-200" aria-hidden="true"></div>
        <button
          v-if="feedId != null && feedId !== ''"
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 text-red-600"
          @click="onUnsubscribe"
        >
          Unsubscribe
        </button>
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100"
          @click="onLogout"
        >
          Sign out
        </button>
      </div>
    </div>
  </header>
</template>
