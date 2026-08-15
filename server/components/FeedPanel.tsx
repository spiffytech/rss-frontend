import type { FC } from 'hono/jsx'

import type { MinifluxCategoryCount, MinifluxFeed } from '../lib/types'

interface FeedPanelProps {
  categories: MinifluxCategoryCount[]
  feeds: MinifluxFeed[]
  counters: Record<string, number>
  /** Preserve the current view mode in generated nav links. */
  viewMode: 'expanded' | 'list'
  /** Preserve the hide-read-items toggle in generated nav links. */
  hideReadItems?: boolean
  /** Preserve the per-feed sort in generated nav links. */
  sort?: 'oldest' | 'newest'
}

/** Feed favicon served through our proxy (Miniflux needs the auth header). */
/** Letter avatar shown only if the feed's favicon fails to load. */
const FeedLetter: FC<{ title: string }> = ({ title }) => (
  <span
    class="inline-flex items-center justify-center w-5 h-5 rounded-sm bg-gray-200 text-gray-600 text-xs font-semibold shrink-0"
    style="display: none"
  >
    {(title.trim()[0] ?? '?').toUpperCase()}
  </span>
)

const FeedIcon: FC<{ feedId: number; title: string }> = ({ feedId, title }) => (
  <span class="inline-flex items-center shrink-0 relative" aria-hidden="true">
    <img
      src={`/api/feeds/${feedId}/icon`}
      alt=""
      class="w-5 h-5 rounded-sm"
      loading="lazy"
    />
    <FeedLetter title={title} />
  </span>
)

const FeedPanel: FC<FeedPanelProps> = ({ categories, feeds, counters, viewMode, hideReadItems, sort }) => {
  const feedsByCategory = new Map<number, MinifluxFeed[]>()
  for (const feed of feeds) {
    const catId = feed.category?.id ?? 0
    const list = feedsByCategory.get(catId) ?? []
    list.push(feed)
    feedsByCategory.set(catId, list)
  }
  const uncategorized = feedsByCategory.get(0) ?? []

  // Folders (categories) sorted alphabetically, case-insensitive. Miniflux
  // returns them in creation order, which reads as random in the sidebar.
  // Some names carry an import-order prefix ("1. Comics", "2.1 Org Blogs",
  // "5. Jacksfilms") that would otherwise dominate sorting; strip the
  // numeric prefix for the compare and use the original title as a tiebreak
  // when stripped names collide.
  const catName = (t: string): string => {
    // Strip import-order prefixes: "1. Comics" → "Comics",
    // "2.1 Org Blogs" → "Org Blogs". Try dot+space first, then space-only.
    let s = t.replace(/^\d+(?:\.\d+)*\.\s+/, '')
    if (s === t) s = t.replace(/^\d+(?:\.\d+)*\s+/, '')
    return s
  }
  const sortedCategories = [...categories].sort((a, b) => {
    const na = catName(a.title)
    const nb = catName(b.title)
    const cmp = na.localeCompare(nb, undefined, { sensitivity: 'base' })
    if (cmp !== 0) return cmp
    return a.title.localeCompare(b.title, undefined, { numeric: true })
  })

  const totalUnread = Object.values(counters).reduce((a, b) => a + b, 0)

  /** Build a full-page nav URL preserving view mode, read-items and sort. */
  const link = (params: Record<string, string | number | null | undefined>) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') q.set(k, String(v))
    }
    if (viewMode === 'list') q.set('view', 'list')
    if (!hideReadItems) q.set('hideReadItems', '0')
    if (sort === 'newest') q.set('sort', 'newest')
    const s = q.toString()
    return s ? `/?${s}` : '/'
  }

  return (
    <aside
      data-testid="feed-panel"
      class="border-r border-gray-200 pr-2 overflow-y-auto min-h-0"
    >
      <div class="mb-1">
        <div class="font-semibold text-sm mb-1">Sections</div>
        <ul class="text-sm">
          <li>
            <a
              href={link({})}
              class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center"
              data-class:bg-gray-100={`($filter.feedId === '' || $filter.feedId === null) && $filter.starred === false && ($filter.categoryId === '' || $filter.categoryId === null)`}
            >
              <span>Latest</span>
              <span class="text-xs text-gray-500">{totalUnread}</span>
            </a>
          </li>
          <li>
            <a
              href={link({ starred: 1 })}
              class="w-full text-left px-2 py-1 rounded hover:bg-gray-100 flex justify-between items-center"
              data-class:bg-gray-100={`$filter.starred === true`}
            >
              <span>Starred</span>
            </a>
          </li>
        </ul>
      </div>

      <div>
        <div class="font-semibold text-sm mb-1">Feeds</div>
        {sortedCategories.map((cat) => {
          const catFeeds = feedsByCategory.get(cat.id) ?? []
          return (
            <div class="mb-1" key={cat.id}>
              <button
                type="button"
                class="group w-full text-left px-2 py-2 rounded hover:bg-gray-100 flex items-center gap-x-2 text-sm font-semibold"
                data-on:click={`$collapsedCats[${cat.id}] = !$collapsedCats[${cat.id}]`}
              >
                <span class="flex-1 truncate">
                  <span data-text={`$collapsedCats[${cat.id}] ? '▸' : '▾'`}></span> {cat.title}
                </span>
                <span class="ml-auto relative w-[2.5ch] shrink-0 text-right">
                  <span class="text-xs text-gray-500 group-hover:opacity-0">{cat.total_unread}</span>
                  <button
                    type="button"
                    title="Rename folder"
                    class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                    data-on:click__stop={`evt.preventDefault(); const n = prompt('Rename folder "${cat.title.replace(/"/g, '&quot;')}"', ${JSON.stringify(cat.title)}); if (n && n.trim() && n.trim() !== ${JSON.stringify(cat.title)}) location.href = '/api/categories/${cat.id}/rename?title=' + encodeURIComponent(n.trim())`}
                  >
                    ✎
                  </button>
                </span>
              </button>
              <ul class="ml-3" data-show={`!$collapsedCats[${cat.id}]`}>
                {catFeeds.map((feed) => (
                  <li
                    key={feed.id}
                    class="group"
                    data-show={`${counters[feed.id] ?? 0} > 0 || !$hideEmptyFeeds`}
                  >
                    <a
                      href={link({ feed: feed.id })}
                      class="w-full text-left px-2 py-2 rounded hover:bg-gray-100 flex items-center gap-x-2 text-sm"
                      data-class:bg-gray-100={`$filter.feedId === ${feed.id}`}
                    >
                      <FeedIcon feedId={feed.id} title={feed.title} />
                      <span class="flex-1 truncate">{feed.title}</span>
                      <span class="ml-auto relative w-[2.5ch] shrink-0 text-right">
                        <span class="text-xs text-gray-500 group-hover:opacity-0">{counters[feed.id] ?? 0}</span>
                        <button
                          type="button"
                          title="Rename feed"
                          class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                          data-on:click__stop={`evt.preventDefault(); const n = prompt('Rename feed "${feed.title.replace(/"/g, '&quot;')}"', ${JSON.stringify(feed.title)}); if (n && n.trim() && n.trim() !== ${JSON.stringify(feed.title)}) location.href = '/api/feeds/${feed.id}/rename?title=' + encodeURIComponent(n.trim())`}
                        >
                          ✎
                        </button>
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
        {uncategorized.length > 0 && (
          <ul class="ml-3">
            {uncategorized.map((feed) => (
              <li
                key={feed.id}
                class="group"
                data-show={`${counters[feed.id] ?? 0} > 0 || !$hideEmptyFeeds`}
              >
                <a
                  href={link({ feed: feed.id })}
                  class="w-full text-left px-2 py-2 rounded hover:bg-gray-100 flex items-center gap-x-2 text-sm"
                  data-class:bg-gray-100={`$filter.feedId === ${feed.id}`}
                >
                  <FeedIcon feedId={feed.id} title={feed.title} />
                  <span class="flex-1 truncate">{feed.title}</span>
                      <span class="ml-auto relative w-[2.5ch] shrink-0 text-right">
                        <span class="text-xs text-gray-500 group-hover:opacity-0">{counters[feed.id] ?? 0}</span>
                        <button
                          type="button"
                          title="Rename feed"
                          class="absolute inset-y-0 right-0 text-xs text-gray-500 opacity-0 group-hover:opacity-100 hover:text-gray-900 px-0.5 cursor-pointer"
                          data-on:click__stop={`evt.preventDefault(); const n = prompt('Rename feed "${feed.title.replace(/"/g, '&quot;')}"', ${JSON.stringify(feed.title)}); if (n && n.trim() && n.trim() !== ${JSON.stringify(feed.title)}) location.href = '/api/feeds/${feed.id}/rename?title=' + encodeURIComponent(n.trim())`}
                        >
                          ✎
                        </button>
                      </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  )
}

export default FeedPanel