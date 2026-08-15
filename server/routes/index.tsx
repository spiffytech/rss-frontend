import { Hono } from 'hono'
import type { FC } from 'hono/jsx'

import IndexView from '../views/index'
import * as miniflux from '../lib/miniflux'
import { computeUnreadCount } from '../lib/util'
import type { EntriesFilter, MinifluxFeed } from '../lib/types'

/** Parse the filter + view from the URL query string (e.g. ?feed=155&starred=1&view=list). */
function parseFilterFromUrl(query: URLSearchParams): { filter: EntriesFilter; viewMode: 'expanded' | 'list' } {
  const filter: EntriesFilter = {
    status: 'unread',
  }
  const feed = Number(query.get('feed'))
  if (Number.isInteger(feed) && feed > 0) filter.feedId = feed
  const cat = Number(query.get('category'))
  if (Number.isInteger(cat) && cat > 0) filter.categoryId = cat
  if (query.get('starred') === '1') filter.starred = true
  const search = query.get('search')
  if (search) filter.search = search
  if (query.get('sort') === 'newest') filter.sort = 'newest'
  // Hide read items by default; only ?hideReadItems=0 reveals them. An absent
  // value must mean "hide", so default true here — !undefined would leak read.
  filter.hideReadItems = query.get('hideReadItems') !== '0'
  const viewMode = query.get('view') === 'list' ? 'list' : 'expanded'
  return { filter, viewMode }
}

/** 404 page for dead/nonexistent feeds. Reuses login-card aesthetic. */
const NotFoundPage: FC<{ feedId: number }> = ({ feedId }) => (
  <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Feed not found — Miniflux Reader</title>
      <link rel="icon" href="/favicon.svg" />
      <link rel="stylesheet" href="/style.css" />
    </head>
    <body class="min-h-dvh bg-gray-50 text-gray-900 flex items-center justify-center p-4">
      <main class="w-full max-w-sm">
        <div class="bg-white border border-gray-200 rounded-lg shadow-sm p-8 flex flex-col gap-6 items-center text-center">
          <svg aria-hidden="true" viewBox="0 0 32 32" class="w-14 h-14">
            <rect width="32" height="32" rx="6" fill="#0e7490"/>
            <text x="16" y="22" font-size="18" font-family="sans-serif" font-weight="bold" text-anchor="middle" fill="white">M</text>
          </svg>
          <div class="flex flex-col gap-1.5">
            <h1 class="text-lg font-semibold leading-6">Feed not found</h1>
            <p class="text-sm text-gray-500 leading-5">
              Feed <span class="font-mono">{feedId}</span> doesn't exist or has been deleted. It may have been unsubscribed, or the ID is invalid.
            </p>
          </div>
          <a
            href="/"
            class="self-center min-w-40 w-full sm:w-auto bg-cyan-700 text-white rounded-full px-10 py-2.5 font-medium shadow-sm hover:bg-cyan-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-700 focus-visible:ring-offset-2 active:bg-cyan-900 active:translate-y-px"
          >
            Back to Latest
          </a>
        </div>
      </main>
    </body>
  </html>
)
export const indexRoutes = new Hono().get('/', async (ctx) => {
  const { filter, viewMode } = parseFilterFromUrl(new URL(ctx.req.url).searchParams)
  try {
    const [feeds, categories, counters, page] = await Promise.all([
      miniflux.getFeeds(),
      miniflux.getCategories(),
      miniflux.getCounters(),
      miniflux.getEntriesPage(filter),
    ])

    // Compute the toolbar title from the requested filter.
    let currentTitle = 'Latest'
    if (filter.feedId != null) {
      const feed = feeds.find((f: MinifluxFeed) => f.id === filter.feedId)
      currentTitle = feed?.title ?? `Feed ${filter.feedId}`
    } else if (filter.starred) {
      currentTitle = 'Starred'
    }
    const unreadCount = computeUnreadCount(filter, feeds, counters.unreads)

    return ctx.html(
      <IndexView
        feeds={feeds}
        categories={categories}
        counters={counters.unreads}
        entries={page.entries}
        nextCursor={page.nextCursor}
        hasMore={page.hasMore}
        initialFilter={filter}
        initialViewMode={viewMode}
        currentTitle={currentTitle}
        unreadCount={unreadCount}
      />,
    )
  } catch (err) {
    // Dead feed: Miniflux returns 400/404 for a nonexistent feed_id.
    if (err instanceof miniflux.MinifluxError && (err.status === 400 || err.status === 404) && filter.feedId != null && filter.feedId !== '') {
      return ctx.html(<NotFoundPage feedId={filter.feedId} />, 404)
    }
    throw err
  }
})
