import { For, Show, createMemo } from 'solid-js'
import { useNavigate } from '@solidjs/router'

import type { FeedId } from '../shared/ids'
import type { FeedInfo } from '../shared/types'
import { DEFAULT_HIDE_EMPTY_FEEDS } from '../shared/prefs'
import { hasView } from '../shared/filter'
import { compareTitlesCI } from '../shared/util'
import { autofocus } from '../lib/observers'
import { useReader } from '../lib/reader-context'
import { FeedIcon } from './FeedIcon'

/**
 * The sidebar: Sections (Latest/Starred) + Feeds (uncategorized, then category
 * folders with inline rename editors and the hover-pencil).
 *
 * Navigation is URL-first: picking a feed is a link, so the reading view's
 * identity stays in the address bar. Re-clicking the active feed is the one
 * exception — it refetches page 1 in place, because new items may have arrived
 * since the list windowed.
 */
export const FeedPanel = () => {
  const r = useReader()
  const { cancelRename, refreshPanel, saveRename, startRename } = r
  const navigate = useNavigate()

  // Case-insensitive order inside each folder (the server hands them over in
  // SQLite's binary collation order, which puts every capital letter first).
  /** A folder's total is the sum of the feed counts under it, not a separate number. */
  const categoryUnread = (categoryId: string): number =>
    (feedsByCategory().get(categoryId) ?? []).reduce((total, feed) => total + r.counterFor(feed.id), 0)

  const feedsByCategory = createMemo(() => {
    const map = new Map<string, FeedInfo[]>()
    const sorted = [...r.panel.feeds].sort((a, b) => compareTitlesCI(a.title, b.title))
    for (const feed of sorted) {
      const list = map.get(feed.categoryId) ?? []
      list.push(feed)
      map.set(feed.categoryId, list)
    }
    return map
  })

  const sortedCategories = createMemo(() =>
    [...r.panel.categories].sort((a, b) => compareTitlesCI(a.title, b.title)),
  )

  /** Identity-only nav URL (which feed/category/section). */
  const link = (params: Record<string, string | number | null | undefined>): string => {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== '') query.set(key, String(value))
    }
    const queryString = query.toString()
    return queryString ? `/?${queryString}` : '/'
  }

  const isActiveFeed = (feedId: string) => r.filter().feedId === feedId
  const isRenamingFeed = (feedId: string) =>
    r.session.renameId === feedId && r.session.renameKind === 'feed'
  const isRenamingCategory = (categoryId: string) =>
    r.session.renameId === categoryId && r.session.renameKind === 'category'

  const hideEmptyFeeds = () => r.panel.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS

  const showCategory = (catFeeds: FeedInfo[]): boolean => {
    if (!hideEmptyFeeds()) return true
    const hasUnread = catFeeds.some((feed) => (r.counterFor(feed.id)) > 0)
    const hasActive = catFeeds.some((feed) => r.filter().feedId === feed.id)
    return hasUnread || hasActive
  }

  const onRenameKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') void saveRename()
    else if (event.key === 'Escape') cancelRename()
  }

  const RenameEditor = (props: { onCancel: () => void; onSave: () => void }) => (
    <span class="flex flex-col flex-1 min-w-0 gap-1">
      <input
        type="text"
        ref={autofocus}
        class="w-full p-0.5 border border-gray-300 rounded text-sm"
        value={r.session.renameTitle}
        onInput={(event) => r.setRenameTitle(event.currentTarget.value)}
        onKeyDown={onRenameKeydown}
      />
      <div class="flex items-center justify-end gap-1">
        <button
          type="button"
          class="text-xs shrink-0 px-2 py-0.5 rounded-md bg-cyan-700 text-white hover:bg-cyan-800"
          onClick={props.onSave}
        >
          Save
        </button>
        <button
          type="button"
          class="text-xs shrink-0 px-2 py-0.5 rounded-md border border-gray-300 hover:bg-gray-100"
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </span>
  )

  return (
    <aside
      data-testid="feed-panel"
      class="border-r border-gray-200 pr-2 overflow-y-auto min-h-0"
    >
      <div class="mb-1">
        <h2 class="font-semibold text-sm mb-1">Sections</h2>
        <ul class="text-sm">
          <li>
            {/* No filter means the home page. It is first because it is the way
                back out of any feed — the toolbar title does this on desktop, but
                on mobile the title is hidden and this list is the only nav. */}
            <a
              href="/"
              data-testid="home-link"
              class={[
                'w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center',
                { 'bg-gray-100': !hasView(r.filter()) },
              ]}
            >
              <span>Home</span>
            </a>
          </li>
          <li>
            <a
              href={link({ starred: 1 })}
              class={[
                'w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center',
                { 'bg-gray-100': r.filter().starred === true },
              ]}
            >
              <span>Starred</span>
            </a>
          </li>
        </ul>
      </div>

      <div>
        <h2 class="font-semibold text-sm mb-1">Feeds</h2>

        <ul>
          <For each={sortedCategories()}>
            {(category) => (
              <Show when={showCategory(feedsByCategory().get(category.id) ?? [])}>
                <li>
                  <div class="group flex items-baseline gap-x-2 text-sm font-semibold">
                    <Show
                      when={isRenamingCategory(category.id)}
                      fallback={
                        <h2 class="flex-1 min-w-0 text-sm font-semibold truncate py-2">
                          {category.title}
                        </h2>
                      }
                    >
                      <RenameEditor
                        onCancel={cancelRename}
                        onSave={() => void saveRename()}
                      />
                    </Show>
                    <span class="relative flex items-baseline gap-x-1 shrink-0">
                      <span
                        data-testid="feed-count"
                        class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0"
                      >
                        {categoryUnread(category.id)}
                      </span>
                      <button
                        type="button"
                        title="Rename folder"
                        class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                        onClick={() => startRename(category.id, 'category', category.title)}
                      >
                        ✎
                      </button>
                    </span>
                  </div>
                  <ul class="ml-3">
                    <For each={feedsByCategory().get(category.id) ?? []}>
                      {(feed) => (
                        <li
                          class={[
                            // Baseline-aligned so the feed name and its count
                            // sit on one line of text; the icon opts back into
                            // centring for itself.
                            'group flex items-baseline gap-x-2 text-sm',
                            {
                              hidden:
                                hideEmptyFeeds() &&
                                (r.counterFor(feed.id)) === 0 &&
                                !isActiveFeed(feed.id),
                            },
                          ]}
                        >
                          <FeedIcon feedId={feed.id} title={feed.title} />
                          <Show
                            when={isRenamingFeed(feed.id)}
                            fallback={
                              <a
                                href={link({ feed: feed.id })}
                                class={[
                                  'flex-1 min-w-0 flex items-baseline gap-x-2 py-2 rounded hover:bg-gray-100',
                                  { 'bg-gray-100': isActiveFeed(feed.id) },
                                ]}
                                onClick={(event) => {
                                  event.preventDefault()
                                  if (isActiveFeed(feed.id)) refreshPanel()
                                  else void navigate(link({ feed: feed.id }))
                                }}
                              >
                                <span class="flex-1 truncate">{feed.title}</span>
                              </a>
                            }
                          >
                            <RenameEditor onCancel={cancelRename} onSave={() => void saveRename()} />
                          </Show>
                          {/* Right-hand cluster, left to right: fetch errors,
                              favorite, unread count (which the pencil replaces
                              on hover). Sanctioned deviations, both of them. */}
                          <span class="relative flex items-baseline gap-x-1 shrink-0">
                            <Show when={feed.parsingErrorCount > 0}>
                              <span title="Fetch errors">⚠️</span>
                            </Show>
                            <Show when={r.isFavorite(feed.id)}>
                              <span
                                data-testid="feed-favorite"
                                title="On the home page"
                                class="shrink-0 text-xs text-amber-500"
                              >
                                ★
                              </span>
                            </Show>
                            <span
                              data-testid="feed-count"
                              class="text-xs text-gray-500 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-0"
                            >
                              {r.counterFor(feed.id)}
                            </span>
                            <button
                              type="button"
                              title="Rename feed"
                              class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 transition-opacity duration-150 group-hover:delay-250 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                              onClick={() => startRename(feed.id, 'feed', feed.title)}
                            >
                              ✎
                            </button>
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </li>
              </Show>
            )}
          </For>
        </ul>
      </div>
    </aside>
  )
}

export default FeedPanel
