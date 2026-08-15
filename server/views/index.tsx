import type { FC } from 'hono/jsx'

import Layout from '../components/Layout'
import { AppContainer } from '../components/AppContainer'
import TopToolbar from '../components/TopToolbar'
import FeedPanel from '../components/FeedPanel'
import EntryList from '../components/EntryList'
import type { EntriesFilter, MinifluxCategoryCount, MinifluxEntry, MinifluxFeed } from '../lib/types'

interface IndexViewProps {
  feeds: MinifluxFeed[]
  categories: MinifluxCategoryCount[]
  counters: Record<string, number>
  entries: MinifluxEntry[]
  nextCursor?: string
  hasMore?: boolean
  initialFilter: EntriesFilter
  initialViewMode: 'expanded' | 'list'
  currentTitle: string
  /** Unread count for the current feed/section, or null when not meaningful (Starred). */
  unreadCount: number | null
}

/** Datastar expression (string) that serializes the live signals into a URL query string. */
const toQueryStringExpr = (): string =>
  "((Number($filter.feedId||'') ? 'feed=' + $filter.feedId : '') + (Number($filter.categoryId||'') ? '&category=' + $filter.categoryId : '') + ($filter.starred ? '&starred=1' : '') + ($filter.search ? '&search=' + encodeURIComponent($filter.search) : '') + ($filter.sort === 'newest' ? '&sort=newest' : '') + ($hideReadItems ? '' : '&hideReadItems=0') + ($viewMode === 'list' ? '&view=list' : '')).replace(/^&/, '')"

const IndexView: FC<IndexViewProps> = ({
  feeds,
  categories,
  counters,
  entries,
  nextCursor,
  hasMore,
  initialFilter,
  initialViewMode,
  currentTitle,
  unreadCount,
}) => {
  const filter: Record<string, unknown> = {
    status: initialFilter.status ?? 'unread',
    starred: initialFilter.starred ?? false,
    search: initialFilter.search ?? '',
    sort: initialFilter.sort ?? 'oldest',
  }
  if (initialFilter.feedId != null) filter.feedId = initialFilter.feedId
  if (initialFilter.categoryId != null) filter.categoryId = initialFilter.categoryId
  const signals = {
    filter,
    viewMode: initialViewMode,
    currentTitle,
    unreadCount,
    userHasScrolled: false,
    collapsedCats: {} as Record<number, boolean>,
    keepUnreadIds: [] as number[],
    // Persisted preferences (localStorage), deliberately NOT in the URL.
    hideEmptyFeeds: true,
    hideReadItems: initialFilter.hideReadItems ?? true,
    // Per-feed auto-read disable (persisted). Default: auto-read on for all.
    disabledAutoReadFeeds: [] as number[],
    // Infinite-scroll pagination state.
    nextCursor: nextCursor ?? null,
    hasMore: hasMore ?? false,
    loadingMore: false,
    // UI transient state.
    menuOpen: false,
    searchOpen: false,
    sidebarOpen: false,
  }
  const keydown = [
    "if(evt.key === 'j'){ window.dsNav(1); }",
    "if(evt.key === 'k'){ window.dsNav(-1); }",
    "if(evt.key === 'm'){ const id = window.dsCurrentId(); if(id){ @post('/api/entries/' + id + '/toggle-read'); } }",
    "if(evt.key === 's'){ const id = window.dsCurrentId(); if(id){ @post('/api/entries/' + id + '/star'); } }",
    "if(evt.key === 'v'){ const q = new URLSearchParams(location.search); q.set('view', $viewMode === 'expanded' ? 'list' : 'expanded'); location.href = location.pathname + '?' + q.toString(); }",
    "if(evt.key === 'A' && evt.shiftKey){ @put('/api/mark-all-read', { payload: { entryIds: window.dsEntryIds() } }); }",
  ].join(' ')
  return (
    <Layout>
      <AppContainer
        signals={signals}
        onKeydown={keydown}
        watchFilter={`history.replaceState(null, '', window.location.pathname + '?' + (${toQueryStringExpr()}))`}
        className="grid grid-rows-[auto_1fr] app-container flex-1 min-h-0"
      >
        <TopToolbar
          currentTitle={currentTitle}
          unreadCount={unreadCount}
          filter={{
            feedId: initialFilter.feedId ?? null,
            sort: initialFilter.sort ?? 'oldest',
            viewMode: initialViewMode,
            hideReadItems: initialFilter.hideReadItems ?? true,
          }}
        />
        <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
          {/* Sidebar: static column on md+ (via CSS `md:!block`), off-canvas
              drawer on mobile toggled by `data-show="$sidebarOpen"`. Splitting
              these keeps desktop visibility out of the signal layer, so a boot
              `isMobile` patch can't race/swallow the first hamburger click. */}
          <div
            class="app-sidebar max-md:hidden fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto"
            {...{ 'data-show': `$sidebarOpen` }}
          >
            <div class="flex justify-end md:hidden p-2">
              <button type="button" class="px-2 py-2 border border-gray-300 rounded-md" data-on:click="$sidebarOpen = false">
                ✕
              </button>
            </div>
            <FeedPanel categories={categories} feeds={feeds} counters={counters} viewMode={initialViewMode} hideReadItems={initialFilter.hideReadItems ?? true} sort={initialFilter.sort} />
          </div>
          {/* Scrim on mobile while the drawer is open */}
          <div
            class="fixed inset-0 z-20 bg-black/30 md:hidden"
            data-show="$sidebarOpen"
            data-on:click="$sidebarOpen = false"
          ></div>
          {/* Drag-to-resize handle (desktop only): sits in the grid gap. */}
          <div
            id="sidebar-resize"
            class="absolute top-0 bottom-0 z-40 hidden md:block cursor-col-resize touch-none hover:bg-cyan-700/20"
            style={{ left: 'calc(var(--sidebar-w) + 3px)', width: '6px' }}
            aria-hidden="true"
          ></div>
          <div class="overflow-y-auto min-h-0" {...{ 'data-on:scroll': '$userHasScrolled = true' }}>
            <EntryList entries={entries} viewMode={initialViewMode} />
          </div>
        </div>
      </AppContainer>
    </Layout>
  )
}

export default IndexView
