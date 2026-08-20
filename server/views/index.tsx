import type { FC } from 'hono/jsx'

import Layout from '../components/Layout'
import { AppContainer } from '../components/AppContainer'
import TopToolbar from '../components/TopToolbar'
import FeedPanel from '../components/FeedPanel'
import EntryList from '../components/EntryList'
import type { EntriesFilter, MinifluxCategoryCount, MinifluxEntry, MinifluxFeed } from '../lib/types'
import type { UserPrefs } from '../lib/prefs'

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
  /** Account-wide prefs hydrated from the store during SSR. */
  userPrefs: UserPrefs
}

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
  userPrefs,
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
    // Account-wide prefs (server-side, per Miniflux user). `user` scope.
    hideEmptyFeeds: userPrefs.hideEmptyFeeds ?? true,
    collapsedCats: (userPrefs.collapsedCats ?? {}) as Record<number, boolean>,
    disabledAutoReadFeeds: (userPrefs.disabledAutoReadFeeds ?? []) as number[],
    keepUnreadIds: [] as number[],
    hideReadItems: (initialFilter.hideReadItems ?? true) as boolean,
    // Icon fallback state (delegated error handler on the feed panel).
    iconFailed: {} as Record<number, boolean>,
    // The reading anchor: which entry is currently at the top of the viewport.
    // The server seeds it as 0 (no selection) — a fresh list starts unselected
    // and the first j/k press selects. `track-top` refreshes it as the user
    // scrolls (but not on its initial observe). It's a plain number, never
    // null — an empty list renders no navigable entries, so the fallback 0 is
    // never a real target.
    currentId: 0,
    // Transient target for the scroll-into-view watcher. Self-clears so a nav
    // request can't re-trigger, and the scroll watcher never writes currentId,
    // so user scroll → currentId patch → no scrollIntoView loop.
    navRequest: null as number | null,
    // Ids of the entries currently rendered in the list. The server owns this
    // signal (patched on every list replace/append), so "mark all read" and
    // friends are plain `@put` calls — datastar sends the ids along with the
    // rest of the view state. No DOM scraping.
    entryIds: entries.map((e) => e.id),
    // Inline rename editor state.
    renameId: null as number | null,
    renameKind: null as 'feed' | 'category' | null,
    renameTitle: '',
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
    "if(evt.key === 'j' || evt.key === 'ArrowDown'){ evt.preventDefault(); const i = $entryIds.indexOf($currentId); $currentId = $entryIds[Math.min($entryIds.length - 1, i + 1)]; $navRequest = $currentId; @post('/api/entries/' + $currentId + '/auto-read'); }",
    "if(evt.key === 'k' || evt.key === 'ArrowUp'){ evt.preventDefault(); const i = $entryIds.indexOf($currentId); $currentId = $entryIds[Math.max(0, i - 1)]; $navRequest = $currentId; @post('/api/entries/' + $currentId + '/auto-read'); }",
    "if(evt.key === 'm'){ @post('/api/entries/' + $currentId + '/toggle-read'); }",
    "if(evt.key === 's'){ @post('/api/entries/' + $currentId + '/star'); }",
    "if(evt.key === 'v'){ $viewMode = $viewMode === 'expanded' ? 'list' : 'expanded'; @put('/api/prefs/view-mode'); }",
    "if(evt.key === 'A' && evt.shiftKey){ @put('/api/mark-all-read'); }",
  ].join(' ')
  return (
    <Layout>
      <AppContainer
        signals={signals}
        onKeydown={keydown}
        className="grid grid-rows-[auto_1fr] app-container flex-1 min-h-0"
      >
        <TopToolbar
          currentTitle={currentTitle}
          unreadCount={unreadCount}
          filter={{ feedId: initialFilter.feedId ?? null }}
        />
        <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
          {/* Scroll-into-view watcher for nav: one DOM effect for the whole app
              (navigation is a state transition; only the actual scroll is
              geometry, done here natively). */}
          <div
            class="hidden"
            data-on-signal-patch-filter="{include: /^navRequest$/}"
            data-on-signal-patch="$navRequest != null && (scrollNav($navRequest), $navRequest = null)"
          ></div>
          {/* Sidebar: static column on md+ (forced by the `!important` rule in
              main.css), off-canvas drawer on mobile toggled by `data-show`.
              NOTE: no `max-md:hidden` class here — `data-show` shows an element
              by removing its own inline `display:none`, and a `display:none`
              class would still apply afterwards, so the drawer could never
              open on mobile. The initial inline `display:none` hides it until
              Datastar boots (no flash), then the signal takes over. */}
          <div
            class="app-sidebar fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto"
            style="display: none"
            {...{ 'data-show': `$sidebarOpen` }}
          >
            <div class="flex justify-end md:hidden p-2">
              <button type="button" class="px-2 py-2 border border-gray-300 rounded-md" data-on:click="$sidebarOpen = false">
                ✕
              </button>
            </div>
            <FeedPanel categories={categories} feeds={feeds} counters={counters} />
          </div>
          {/* Scrim on mobile while the drawer is open. Initial inline
              `display:none` prevents a black flash before Datastar boots
              (`md:hidden` only covers the desktop breakpoint). */}
          <div
            class="fixed inset-0 z-20 bg-black/30 md:hidden"
            style="display: none"
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
          <script
            dangerouslySetInnerHTML={{
              __html: `// Nav scroll: linear interpolation over a fixed budget. Drives real
// scrollTop (not a transform), so track-top / auto-read / sentinel observers
// all see genuine scrolling. Honors prefers-reduced-motion with an instant
// jump.
(() => {
  const SCROLL_MS = 150;
  globalThis.scrollNav = (entryId) => {
    const el = document.getElementById('entry-' + entryId);
    if (!el) return;
    const scroller = el.closest('[data-testid="entry-list"]')?.parentElement
      ?? el.offsetParent;
    if (!scroller) return;
    const to = scroller.scrollTop + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top);
    const from = scroller.scrollTop;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      scroller.scrollTop = to;
      return;
    }
    let start;
    const step = (ts) => {
      if (start === undefined) start = ts;
      const p = Math.min(1, (ts - start) / SCROLL_MS);
      scroller.scrollTop = from + (to - from) * p;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };
})();`,
            }}
          />
        </div>
      </AppContainer>
    </Layout>
  )
}

export default IndexView
