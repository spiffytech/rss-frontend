<script lang="ts">
  import { api } from '../../client/api'
  import { loadBootstrap, appState } from '../../client/state.svelte.js'
  import { parseFilterFromUrl } from '../../shared/filter'
  import type { FeedId } from '../../shared/ids'
  import type { FeedPrefs } from '../../shared/prefs'

  const feeds = $derived(appState.panel.feeds)
  let selectedFeed = $state<FeedId | ''>('')
  let renameFeedTo = $state('')
  let renameCategoryTo = $state('')
  let selectedCategory = $state('')
  let keywords = $state('')
  let authors = $state('')
  let tags = $state('')
  let viewMode = $state<'expanded' | 'list'>('expanded')
  let sort = $state<'oldest' | 'newest'>('oldest')
  let hideReadItems = $state(true)
  let saved = $state('')

  const current = $derived(selectedFeed ? appState.feedPrefs[selectedFeed] : undefined)

  $effect(() => {
    const prefs: FeedPrefs | undefined = selectedFeed ? appState.feedPrefs[selectedFeed] : undefined
    keywords = (prefs?.hiddenKeywords ?? []).join(', ')
    authors = (prefs?.hiddenAuthors ?? []).join(', ')
    tags = (prefs?.hiddenTags ?? []).join(', ')
    viewMode = prefs?.viewMode ?? 'expanded'
    sort = prefs?.sort ?? 'oldest'
    hideReadItems = prefs?.hideReadItems ?? true
  })

  const split = (value: string) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')

  async function saveFeed(): Promise<void> {
    if (!selectedFeed) return
    await api.setFeedPrefs(selectedFeed, {
      hiddenKeywords: split(keywords),
      hiddenAuthors: split(authors),
      hiddenTags: split(tags),
      viewMode,
      sort,
      hideReadItems,
    })
    await loadBootstrap(parseFilterFromUrl({}))
    saved = 'Feed prefs saved.'
  }

  async function renameFeed(): Promise<void> {
    if (!selectedFeed || renameFeedTo.trim() === '') return
    await api.renameFeed(selectedFeed, renameFeedTo.trim())
    await loadBootstrap(parseFilterFromUrl({}))
    saved = 'Feed renamed.'
  }

  async function renameCategory(): Promise<void> {
    if (!selectedCategory || renameCategoryTo.trim() === '') return
    await api.renameCategory(selectedCategory, renameCategoryTo.trim())
    await loadBootstrap(parseFilterFromUrl({}))
    saved = 'Category renamed.'
  }

  async function unsubscribe(): Promise<void> {
    if (!selectedFeed) return
    if (!confirm('Unsubscribe and delete this feed\u2019s entries?')) return
    await api.unsubscribe(selectedFeed)
    selectedFeed = ''
    await loadBootstrap(parseFilterFromUrl({}))
    saved = 'Feed removed.'
  }

  async function saveUser(patch: Record<string, unknown>): Promise<void> {
    await api.setUserPrefs(patch)
    await loadBootstrap(parseFilterFromUrl({}))
    saved = 'Saved.'
  }
</script>

<header class="sticky top-0 border-b border-neutral-200 bg-white/90 px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900/90">
  <h1 class="text-lg font-semibold">Settings</h1>
</header>

<div class="mx-auto max-w-2xl space-y-8 p-4">
  <section>
    <h2 class="mb-2 font-semibold">Per-feed: filters & view</h2>
    <select
      class="w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800"
      bind:value={selectedFeed}
    >
      <option value="">Pick a feed…</option>
      {#each feeds as feed}
        <option value={feed.id}>{feed.title}</option>
      {/each}
    </select>

    {#if selectedFeed}
      <div class="mt-3 space-y-2">
        <label class="block text-sm">
          Hidden keywords (comma-separated, literal, case-insensitive)
          <input class="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" bind:value={keywords} />
        </label>
        <label class="block text-sm">
          Hidden authors
          <input class="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" bind:value={authors} />
        </label>
        <label class="block text-sm">
          Hidden tags
          <input class="mt-0.5 w-full rounded border border-neutral-300 px-2 py-1 dark:border-neutral-700 dark:bg-neutral-800" bind:value={tags} />
        </label>
        <div class="flex gap-4 text-sm">
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={viewMode} value="expanded" /> expanded
          </label>
          <label class="flex items-center gap-1">
            <input type="radio" bind:group={viewMode} value="list" /> list
          </label>
          <label class="flex items-center gap-1">
            <input type="checkbox" bind:checked={hideReadItems} /> hide read items
          </label>
          <select class="rounded border border-neutral-300 px-1 dark:border-neutral-700 dark:bg-neutral-800" bind:value={sort}>
            <option value="oldest">oldest first</option>
            <option value="newest">newest first</option>
          </select>
        </div>
        <button class="rounded bg-neutral-900 px-3 py-1 text-white dark:bg-neutral-100 dark:text-neutral-900" onclick={saveFeed}>
          Save feed prefs
        </button>
      </div>

      <div class="mt-4 space-y-2 border-t border-neutral-200 pt-3 dark:border-neutral-800">
        <div class="flex gap-2">
          <input
            class="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
            placeholder="New feed title"
            bind:value={renameFeedTo}
          />
          <button class="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700" onclick={renameFeed}>
            Rename feed
          </button>
        </div>
        <button class="rounded border border-red-300 px-2 py-1 text-sm text-red-600" onclick={unsubscribe}>
          Unsubscribe\u2026
        </button>
      </div>
    {/if}
  </section>

  <section>
    <h2 class="mb-2 font-semibold">Categories</h2>
    <div class="flex gap-2">
      <select
        class="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
        bind:value={selectedCategory}
      >
        <option value="">Pick a category\u2026</option>
        {#each appState.panel.categories as category}
          <option value={category.id}>{category.title}</option>
        {/each}
      </select>
      <input
        class="flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
        placeholder="New category title"
        bind:value={renameCategoryTo}
      />
      <button class="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700" onclick={renameCategory}>
        Rename
      </button>
    </div>
  </section>

  <section>
    <h2 class="mb-2 font-semibold">Account</h2>
    <label class="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={appState.userPrefs.hideEmptyFeeds === true}
        onchange={(e) => saveUser({ hideEmptyFeeds: e.currentTarget.checked })}
      />
      hide feeds with no unread items
    </label>
    <p class="mt-3 text-sm text-neutral-500">
      Passwords are set from the shell (never through the browser):
      <code class="rounded bg-neutral-200 px-1 dark:bg-neutral-800">echo -n 'new pw' | bun run scripts/set-password.ts {appState.session.username}</code>
    </p>
  </section>

  {#if saved}<p class="text-sm text-green-600">{saved}</p>{/if}
</div>
