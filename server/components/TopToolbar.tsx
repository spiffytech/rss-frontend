import type { FC, PropsWithChildren } from 'hono/jsx'

interface TopToolbarProps {
  currentTitle: string
  unreadCount: number | null
  /** Current nav state (from the URL) so menu rows can build full-page links. */
  filter: {
    feedId?: number | string | null
    sort?: 'oldest' | 'newest'
    viewMode: 'expanded' | 'list'
    hideReadItems?: boolean
  }
}

/** A dropdown menu triggered by a button; opener toggles `$menuOpen` and an
 * outside-click (datastar `__outside`) closes it. `__stop` on the opener keeps
 * its click from bubbling into the outside detector. The panel is anchored to
 * the button (`absolute right-0`), and the button is pinned to the toolbar's
 * right edge (`ml-auto`) so it never wraps to a spot with no room on its right. */
const Menu: FC<PropsWithChildren<{ label: string }>> = ({ label, children }) => (
  <div class="relative ml-auto">
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title={label}
      aria-haspopup="menu"
      aria-expanded="$menuOpen"
      data-on:click__stop="$menuOpen = !$menuOpen"
      data-attr:aria-expanded="$menuOpen ? 'true' : 'false'"
    >
      ⋯
    </button>
    <div
      class="absolute right-0 mt-1 w-56 max-w-[calc(100vw-1rem)] bg-white border border-gray-200 rounded-md shadow-lg z-20 py-1 text-sm"
      data-show="$menuOpen"
      data-on:click__outside="$menuOpen = false"
    >
      {children}
    </div>
  </div>
)

/** A toggle row inside a menu, with a check. Used for CSS-only prefs
 * (show-read-feeds); rows that change server output are full-page links. */
const MenuToggle: FC<{ signal: string; label: string }> = ({ signal, label }) => (
  <button
    type="button"
    class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
    data-on:click={`$${signal} = !$${signal}`}
  >
    <span data-text={`$${signal} ? '✓' : ''`} class="w-4 inline-block"></span>
    {label}
  </button>
)

const TopToolbar: FC<TopToolbarProps> = ({ currentTitle, unreadCount, filter }) => {
  /** Build a full-page nav URL preserving the given params (lean into SSR). */
  const link = (params: Record<string, string | number | null | undefined>): string => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') q.set(k, String(v))
    }
    const s = q.toString()
    return s ? `/?${s}` : '/'
  }
  const { feedId, sort = 'oldest', viewMode, hideReadItems } = filter

  return (
  <header class="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 border-b-2 border-gray-300 mb-2">
    {/* Mobile hamburger: toggles the sidebar drawer */}
    <button
      type="button"
      class="md:hidden px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Toggle feed list"
      data-on:click="$sidebarOpen = !$sidebarOpen"
    >
      ☰
    </button>

    <a href="/" class="hidden md:inline font-semibold text-lg mr-auto">
      Miniflux Reader
    </a>

    <span class="text-sm text-gray-500 min-w-0 flex-1 truncate md:flex-none md:mr-auto">
      <span data-text="$currentTitle">{currentTitle}</span>
      <span
        class="text-xs text-gray-400"
        data-show="$unreadCount != null"
        data-text="$unreadCount != null ? (' (' + $unreadCount + ')') : ''"
      >
        {unreadCount != null ? ` (${unreadCount})` : ''}
      </span>
    </span>

    {/* Mobile: search icon expands a search field */}
    <button
      type="button"
      class="md:hidden px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Search"
      aria-expanded="$searchOpen"
      data-on:click__stop="$searchOpen = !$searchOpen"
      data-attr:aria-expanded="$searchOpen ? 'true' : 'false'"
    >
      🔍
    </button>
    <input
      type="search"
      placeholder="Search…"
      class="md:hidden w-full p-2 border border-gray-300 rounded-md"
      data-show="$searchOpen"
      data-bind="filter.search"
      {...{ 'data-on:input__debounce.300ms': "@get('/api/entries')" }}
    />

    {/* Prev / next story */}
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Previous (k)"
      data-on:click="window.dsNav(-1)"
    >
      ▲
    </button>
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Next (j)"
      data-on:click="window.dsNav(1)"
    >
      ▼
    </button>
    <button
      type="button"
      class="px-2 py-2 border border-gray-300 rounded-md hover:bg-gray-100 leading-none"
      title="Mark all read (Shift+A)"
      data-on:click={`@put('/api/mark-all-read')`}
    >
      ✓
    </button>

    {/* Per-feed sort toggle removed — lives in the ⋯ menu below. */}

    <input
      type="search"
      placeholder="Search…"
      class="hidden md:block flex-1 max-w-sm min-w-[100px] p-2 border border-gray-300 rounded-md"
      data-bind="filter.search"
      {...{ 'data-on:input__debounce.300ms': "@get('/api/entries')" }}
    />

    <Menu label="View options">
      <a
        href={link({
          feed: feedId,
          sort: viewMode === 'expanded' ? undefined : sort,
          hideReadItems: hideReadItems ? undefined : 0,
          view: viewMode === 'expanded' ? 'list' : undefined,
        })}
        class="w-full text-left px-3 py-1.5 hover:bg-gray-100 block"
      >
        {viewMode === 'expanded' ? 'List view' : 'Expanded view'}
      </a>
      {feedId != null && feedId !== '' && (
        <a
          href={link({
            feed: feedId,
            sort: sort === 'newest' ? 'oldest' : 'newest',
            hideReadItems: hideReadItems ? undefined : 0,
            view: viewMode === 'list' ? 'list' : undefined,
          })}
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 block"
        >
          {sort === 'newest' ? 'Newest first' : 'Oldest first'}
        </a>
      )}
      {feedId != null && feedId !== '' && (
        <button
          type="button"
          class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
          data-on:click={`$disabledAutoReadFeeds = $disabledAutoReadFeeds.includes(${feedId}) ? $disabledAutoReadFeeds.filter(f => f !== ${feedId}) : [...$disabledAutoReadFeeds, ${feedId}]; $menuOpen = false`}
        >
          <span class="w-4 inline-block" data-text={`$disabledAutoReadFeeds.includes(${feedId}) ? '✓' : ''`}></span>
          Disable auto-read
        </button>
      )}
      <MenuToggle signal="hideEmptyFeeds" label="Hide empty feeds" />
      <a
        href={link({
          feed: feedId,
          sort: sort === 'newest' ? 'newest' : undefined,
          hideReadItems: hideReadItems ? 0 : undefined,
          view: viewMode === 'list' ? 'list' : undefined,
        })}
        class="w-full text-left px-3 py-1.5 hover:bg-gray-100 flex items-center gap-2"
      >
        <span class="w-4 inline-block">{hideReadItems ? '✓' : ''}</span>
        Hide read items
      </a>
      <button
        type="button"
        class="w-full text-left px-3 py-1.5 hover:bg-gray-100"
        data-on:click={`@put('/api/mark-all-read'); $menuOpen = false`}
      >
        Mark all read
      </button>
      <button
        type="button"
        class="w-full text-left px-3 py-1.5 hover:bg-gray-100"
        data-on:click={`@put('/api/refresh'); $menuOpen = false`}
      >
        Refresh feeds
      </button>
      {feedId != null && feedId !== '' && (
        <form
          method="post"
          action={`/api/feeds/${feedId}/unsubscribe`}
          class="block"
          onsubmit={`return confirm('Unsubscribe from this feed?')`}
        >
          <button type="submit" class="w-full text-left px-3 py-1.5 hover:bg-gray-100 text-red-600">
            Unsubscribe
          </button>
        </form>
      )}
      <div class="my-1 border-t border-gray-200" aria-hidden="true"></div>
      <form method="post" action="/api/logout" class="block">
        <button type="submit" class="w-full text-left px-3 py-1.5 hover:bg-gray-100 text-red-600">
          Sign out
        </button>
      </form>
    </Menu>
  </header>
  )
}

export default TopToolbar
