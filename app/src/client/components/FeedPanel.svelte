<script lang="ts">
  // FeedPanel — the sidebar: Sections (Latest/Starred) + Feeds (uncategorized,
  // then category folders with inline rename editors and the hover-pencil).
  // Ported verbatim from the old FeedPanel.vue. The one sanctioned addition:
  // the fetch-error warning glyph, to the LEFT of the unread count.
  import { goto } from '$app/navigation'

  import FeedIcon from './FeedIcon.svelte'
  import {
    appState,
    cancelRename,

    reloadEntries,
    saveRename,
    setFilter,
    startRename,
  } from '../state.svelte.js'
  import { autofocus } from '../actions.js'
  import { computeUnreadCount } from '../../shared/util.js'
  import type { FeedInfo } from '../../shared/types'


  const totalUnread = $derived(
    Object.values(appState.panel.counters).reduce((a, b) => a + b, 0),
  )

  const feedsByCategory = $derived.by(() => {
    const map = new Map<string, FeedInfo[]>()
    for (const feed of appState.panel.feeds) {
      const list = map.get(feed.categoryId) ?? []
      list.push(feed)
      map.set(feed.categoryId, list)
    }
    return map
  })

  // Folders (categories) sorted alphabetically, case-insensitive.
  const sortedCategories = $derived(
    [...appState.panel.categories].sort((a, b) =>
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
   *  (new items may have arrived since the list windowed); otherwise navigate. */
  function onClickFeed(feedId: string) {
    if (isActiveFeed(feedId)) {
      void reloadEntries(appState.filter)
    } else {
      void goto(link({ feed: feedId }))
    }
  }

  function isActiveFeed(feedId: string): boolean {
    return appState.filter.feedId === feedId
  }

  function isRenamingFeed(feedId: string): boolean {
    return appState.renameId === feedId && appState.renameKind === 'feed'
  }

  function isRenamingCategory(catId: string): boolean {
    return appState.renameId === catId && appState.renameKind === 'category'
  }

  function onRenameKeydown(evt: KeyboardEvent) {
    if (evt.key === 'Enter') {
      void saveRename()
    } else if (evt.key === 'Escape') {
      cancelRename()
    }
  }

  function isLatestActive(): boolean {
    return (
      (appState.filter.feedId === undefined || appState.filter.feedId === '') &&
      appState.filter.starred !== true &&
      (appState.filter.categoryId === undefined || appState.filter.categoryId === '')
    )
  }

  function isStarredActive(): boolean {
    return appState.filter.starred === true
  }

  function showCategory(catId: string, catFeeds: FeedInfo[]): boolean {
    if (appState.userPrefs.hideEmptyFeeds === true) {
      const hasUnread = catFeeds.some((f) => (appState.panel.counters[f.id] ?? 0) > 0)
      const hasActive = catFeeds.some((f) => appState.filter.feedId === f.id)
      if (!hasUnread && !hasActive) return false
    }
    return true
  }

</script>

<aside data-testid="feed-panel" class="border-r border-gray-200 pr-2 overflow-y-auto min-h-0">
  <div class="mb-1">
    <h2 class="font-semibold text-sm mb-1">Sections</h2>
    <ul class="text-sm">
      <li>
        <a
          href={link({})}
          class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center {isLatestActive()
            ? 'bg-gray-100'
            : ''}"
        >
          <span>Latest</span>
          <span class="text-xs text-gray-500">{totalUnread}</span>
        </a>
      </li>
      <li>
        <a
          href={link({ starred: 1 })}
          class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center {isStarredActive()
            ? 'bg-gray-100'
            : ''}"
        >
          <span>Starred</span>
        </a>
      </li>
    </ul>
  </div>

  <div>
    <h2 class="font-semibold text-sm mb-1">Feeds</h2>

    <ul class:hidden={false}>
      {#each feedsByCategory.get('uncategorized') ?? [] as feed (feed.id)}
        <li
          class="group flex items-center gap-x-2 text-sm"
          class:hidden={(appState.userPrefs.hideEmptyFeeds === true &&
            (appState.panel.counters[feed.id] ?? 0) === 0 &&
            !isActiveFeed(feed.id))}
        >
          <FeedIcon feedId={feed.id} title={feed.title} />
          {#if !isRenamingFeed(feed.id)}
            <a
              href={link({ feed: feed.id })}
              class="flex-1 min-w-0 flex items-center gap-x-2 py-2 rounded hover:bg-gray-100 {isActiveFeed(feed.id)
                ? 'bg-gray-100'
                : ''}"
              onclick={(e) => {
                e.preventDefault()
                onClickFeed(feed.id)
              }}
            >
              <span class="flex-1 truncate">{feed.title}</span>
            </a>
          {:else}
            <span class="flex flex-col flex-1 min-w-0 gap-1">
              <input
                type="text"
                use:autofocus
                class="w-full p-0.5 border border-gray-300 rounded text-sm"
                bind:value={appState.renameTitle}
                onkeydown={onRenameKeydown}
              />
              <div class="flex items-center justify-end gap-1">
                <button
                  type="button"
                  class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                  onclick={() => void saveRename()}
                >
                  Save
                </button>
                <button
                  type="button"
                  class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                  onclick={cancelRename}
                >
                  Cancel
                </button>
              </div>
            </span>
          {/if}
          <!-- Sanctioned deviation: the yellow warning emoji sits LEFT of the count. -->
          <span class="relative flex items-center gap-x-1 shrink-0">
            {#if feed.parsingErrorCount > 0}
              <span title="Fetch errors">⚠️</span>
            {/if}
            <span data-testid="feed-count" class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
              {appState.panel.counters[feed.id] ?? 0}
            </span>
            <button
              type="button"
              title="Rename feed"
              class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
              onclick={() => startRename(feed.id, 'feed', feed.title)}
            >
              ✎
            </button>
          </span>
        </li>
      {/each}
    </ul>

    <ul>
      {#each sortedCategories as cat (cat.id)}
        {#if showCategory(cat.id, feedsByCategory.get(cat.id) ?? [])}
          <li>
            <div class="group flex items-center gap-x-2 text-sm font-semibold">
              {#if !isRenamingCategory(cat.id)}
                <h2 class="flex-1 min-w-0 text-sm font-semibold truncate py-2">{cat.title}</h2>
              {:else}
                <span class="flex flex-col flex-1 min-w-0 gap-1">
                  <input
                    type="text"
                    use:autofocus
                    class="w-full p-0.5 border border-gray-300 rounded text-sm font-normal"
                    bind:value={appState.renameTitle}
                    onkeydown={onRenameKeydown}
                  />
                  <div class="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      class="text-xs font-normal shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                      onclick={() => void saveRename()}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      class="text-xs font-normal shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                      onclick={cancelRename}
                    >
                      Cancel
                    </button>
                  </div>
                </span>
              {/if}
              <span class="relative flex items-center gap-x-1 shrink-0">
                <span data-testid="feed-count" class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
                  {cat.totalUnread}
                </span>
                <button
                  type="button"
                  title="Rename folder"
                  class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                  onclick={() => startRename(cat.id, 'category', cat.title)}
                >
                  ✎
                </button>
              </span>
            </div>
            <ul class="ml-3">
              {#each feedsByCategory.get(cat.id) ?? [] as feed (feed.id)}
                <li
                  class="group flex items-center gap-x-2 text-sm"
                  class:hidden={appState.userPrefs.hideEmptyFeeds === true &&
                    (appState.panel.counters[feed.id] ?? 0) === 0 &&
                    !isActiveFeed(feed.id)}
                >
                  <FeedIcon feedId={feed.id} title={feed.title} />
                  {#if !isRenamingFeed(feed.id)}
                    <a
                      href={link({ feed: feed.id })}
                      class="flex-1 min-w-0 flex items-center gap-x-2 py-2 rounded hover:bg-gray-100 {isActiveFeed(feed.id)
                        ? 'bg-gray-100'
                        : ''}"
                      onclick={(e) => {
                        e.preventDefault()
                        onClickFeed(feed.id)
                      }}
                    >
                      <span class="flex-1 truncate">{feed.title}</span>
                    </a>
                  {:else}
                    <span class="flex flex-col flex-1 min-w-0 gap-1">
                      <input
                        type="text"
                        use:autofocus
                        class="w-full p-0.5 border border-gray-300 rounded text-sm"
                        bind:value={appState.renameTitle}
                        onkeydown={onRenameKeydown}
                      />
                      <div class="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
                          onclick={() => void saveRename()}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
                          onclick={cancelRename}
                        >
                          Cancel
                        </button>
                      </div>
                    </span>
                  {/if}
                  <!-- Sanctioned deviation: the yellow warning emoji sits LEFT of the count. -->
                  <span class="relative flex items-center gap-x-1 shrink-0">
                    {#if feed.parsingErrorCount > 0}
                      <span title="Fetch errors">⚠️</span>
                    {/if}
                    <span data-testid="feed-count" class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0">
                      {appState.panel.counters[feed.id] ?? 0}
                    </span>
                    <button
                      type="button"
                      title="Rename feed"
                      class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                      onclick={() => startRename(feed.id, 'feed', feed.title)}
                    >
                      ✎
                    </button>
                  </span>
                </li>
              {/each}
            </ul>
          </li>
        {/if}
      {/each}
    </ul>
  </div>
</aside>
