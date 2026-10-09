<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'

import { useFeedsStore } from '@/client/stores/feeds'
import { useReaderStore } from '@/client/stores/reader'
import FeedIcon from '@/client/components/FeedIcon.vue'
import type { MinifluxFeed } from '@/shared/types'

const feeds = useFeedsStore()
const reader = useReaderStore()
const router = useRouter()

const totalUnread = computed(() =>
  Object.values(feeds.counters).reduce((a, b) => a + b, 0),
)

const feedsByCategory = computed(() => {
  const map = new Map<number, MinifluxFeed[]>()
  for (const feed of feeds.feeds) {
    const catId = feed.category?.id ?? 0
    const list = map.get(catId) ?? []
    list.push(feed)
    map.set(catId, list)
  }
  return map
})

const uncategorized = computed(() => feedsByCategory.value.get(0) ?? [])

// Folders (categories) sorted alphabetically, case-insensitive.
const sortedCategories = computed(() =>
  [...feeds.categories].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  ),
)

/** Build an identity-only nav URL (which feed/category/section). */
function link(params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `/?${s}` : '/'
}

/** Click a feed in the sidebar: re-clicking the active feed reloads page 1
 *  (new items may have arrived since the list paginated); otherwise navigate. */
function onClickFeed(feedId: number) {
  if (isActiveFeed(feedId)) {
    void reader.reloadView()
  } else {
    router.push(link({ feed: feedId }))
  }
}

function isActiveFeed(feedId: number): boolean {
  return reader.filter.feedId === feedId
}

function isRenamingFeed(feedId: number): boolean {
  return feeds.renameId === feedId && feeds.renameKind === 'feed'
}

function isRenamingCategory(catId: number): boolean {
  return feeds.renameId === catId && feeds.renameKind === 'category'
}

function onRenameKeydown(evt: KeyboardEvent) {
  if (evt.key === 'Enter') {
    feeds.saveRename()
  } else if (evt.key === 'Escape') {
    feeds.cancelRename()
  }
}

function isLatestActive(): boolean {
  return (
    (reader.filter.feedId === '' || reader.filter.feedId == null) &&
    reader.filter.starred === false &&
    (reader.filter.categoryId === '' || reader.filter.categoryId == null)
  )
}

function isStarredActive(): boolean {
  return reader.filter.starred === true
}

function showCategory(catId: number, catFeeds: MinifluxFeed[]): boolean {
  if (feeds.hideEmptyFeeds) {
    const hasUnread = catFeeds.some((f) => (feeds.counters[f.id] ?? 0) > 0)
    const hasActive = catFeeds.some((f) => reader.filter.feedId === f.id)
    if (!hasUnread && !hasActive) return false
  }
  return true
}
</script>

<template>
  <aside
    data-testid="feed-panel"
    class="border-r border-gray-200 pr-2 overflow-y-auto min-h-0"
  >
    <div class="mb-1">
      <h2 class="font-semibold text-sm mb-1">Sections</h2>
      <ul class="text-sm">
        <li>
          <a
            :href="link({})"
            class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center"
            :class="{ 'bg-gray-100': isLatestActive() }"
          >
            <span>Latest</span>
            <span class="text-xs text-gray-500">{{ totalUnread }}</span>
          </a>
        </li>
        <li>
          <a
            :href="link({ starred: 1 })"
            class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center"
            :class="{ 'bg-gray-100': isStarredActive() }"
          >
            <span>Starred</span>
          </a>
        </li>
      </ul>
    </div>

    <div>
      <h2 class="font-semibold text-sm mb-1">Feeds</h2>

      <ul v-if="uncategorized.length > 0">
        <li
          v-for="feed in uncategorized"
          :key="feed.id"
          class="group flex items-center gap-x-2 text-sm"
          :class="{ hidden: feeds.hideEmptyFeeds && (feeds.counters[feed.id] ?? 0) === 0 && !isActiveFeed(feed.id) }"
        >
          <FeedIcon :feed-id="feed.id" :title="feed.title" />
          <a
            v-if="!isRenamingFeed(feed.id)"
            :href="link({ feed: feed.id })"
            class="flex-1 min-w-0 flex items-center gap-x-2 py-2 rounded hover:bg-gray-100"
            :class="{ 'bg-gray-100': isActiveFeed(feed.id) }"
            @click.prevent="onClickFeed(feed.id)"
          >
            <span class="flex-1 truncate">{{ feed.title }}</span>
          </a>
          <!-- Inline rename editor (feed): input + Save/Cancel. -->
          <span v-else class="flex flex-col flex-1 min-w-0 gap-1">
            <input
              v-model="feeds.renameTitle"
              type="text"
              v-focus
              class="w-full p-0.5 border border-gray-300 rounded text-sm"
              @keydown="onRenameKeydown"
            />
            <div class="flex items-center justify-end gap-1">
              <button
                type="button"
                class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                @click="feeds.saveRename()"
              >
                Save
              </button>
              <button
                type="button"
                class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                @click="feeds.cancelRename()"
              >
                Cancel
              </button>
            </div>
          </span>
          <span class="relative w-[2.5ch] shrink-0 text-right">
            <span class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
              {{ feeds.counters[feed.id] ?? 0 }}
            </span>
            <button
              type="button"
              title="Rename feed"
              class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
              @click="feeds.startRename(feed.id, 'feed', feed.title)"
            >
              ✎
            </button>
          </span>
        </li>
      </ul>

      <ul>
        <li
          v-for="cat in sortedCategories"
          :key="cat.id"
          v-show="showCategory(cat.id, feedsByCategory.get(cat.id) ?? [])"
        >
          <div class="group flex items-center gap-x-2 text-sm font-semibold">
            <h2
              v-if="!isRenamingCategory(cat.id)"
              class="flex-1 min-w-0 text-sm font-semibold truncate py-2"
            >
              {{ cat.title }}
            </h2>
            <!-- Inline rename editor (category). -->
            <span v-else class="flex flex-col flex-1 min-w-0 gap-1">
              <input
                v-model="feeds.renameTitle"
                type="text"
                v-focus
                class="w-full p-0.5 border border-gray-300 rounded text-sm font-normal"
                @keydown="onRenameKeydown"
              />
              <div class="flex items-center justify-end gap-1">
                <button
                  type="button"
                  class="text-xs font-normal shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                  @click="feeds.saveRename()"
                >
                  Save
                </button>
                <button
                  type="button"
                  class="text-xs font-normal shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                  @click="feeds.cancelRename()"
                >
                  Cancel
                </button>
              </div>
            </span>
            <span class="relative w-[2.5ch] shrink-0 text-right">
              <span class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
                {{ cat.total_unread }}
              </span>
              <button
                type="button"
                title="Rename folder"
                class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                @click="feeds.startRename(cat.id, 'category', cat.title)"
              >
                ✎
              </button>
            </span>
          </div>
          <ul class="ml-3">
            <li
              v-for="feed in feedsByCategory.get(cat.id) ?? []"
              :key="feed.id"
              class="group flex items-center gap-x-2 text-sm"
              :class="{ hidden: feeds.hideEmptyFeeds && (feeds.counters[feed.id] ?? 0) === 0 && !isActiveFeed(feed.id) }"
            >
              <FeedIcon :feed-id="feed.id" :title="feed.title" />
              <a
                v-if="!isRenamingFeed(feed.id)"
                :href="link({ feed: feed.id })"
                class="flex-1 min-w-0 flex items-center gap-x-2 py-2 rounded hover:bg-gray-100"
                :class="{ 'bg-gray-100': isActiveFeed(feed.id) }"
            @click.prevent="onClickFeed(feed.id)"
              >
                <span class="flex-1 truncate">{{ feed.title }}</span>
              </a>
              <span v-else class="flex flex-col flex-1 min-w-0 gap-1">
                <input
                  v-model="feeds.renameTitle"
                  type="text"
                  v-focus
                  class="w-full p-0.5 border border-gray-300 rounded text-sm"
                  @keydown="onRenameKeydown"
                />
                <div class="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                    @click="feeds.saveRename()"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                    @click="feeds.cancelRename()"
                  >
                    Cancel
                  </button>
                </div>
              </span>
              <span class="relative w-[2.5ch] shrink-0 text-right">
                <span class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
                  {{ feeds.counters[feed.id] ?? 0 }}
                </span>
                <button
                  type="button"
                  title="Rename feed"
                  class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                  @click="feeds.startRename(feed.id, 'feed', feed.title)"
                >
                  ✎
                </button>
              </span>
            </li>
          </ul>
        </li>
      </ul>
    </div>
  </aside>
</template>
