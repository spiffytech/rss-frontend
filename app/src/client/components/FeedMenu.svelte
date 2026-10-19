<script lang="ts">
  // FeedMenu — the toolbar's "where am I" label turned into a menu: the current
  // feed's name and unread count, plus a popover holding everything you can do
  // to the current view. Ported from the old FeedMenu.vue.
  //
  // The panel is a modal <dialog>, which buys light dismiss (via backdrop tap),
  // Escape, focus restoration and immunity to ancestor overflow/clipping for
  // free. Position comes from computePopoverPlacement (src/shared/popover.ts),
  // applied before showModal() so it can never paint a frame in the UA's
  // default centred position.
  //
  // Row styling follows Refactoring UI's action hierarchy: one primary (solid
  // accent), secondary actions as lower-contrast fills with no border, and the
  // destructive action demoted to that same secondary weight — the loud red is
  // reserved for the confirm() step. Rows are always filled rather than filled
  // on hover, because hover does not exist on a touchscreen.
  import { computePopoverPlacement } from '../../shared/popover.js'
  import { autofocus } from '../actions.js'
  import { DEFAULT_HIDE_EMPTY_FEEDS } from '../../shared/prefs.js'
  import { createSearch } from '../search.svelte.js'
  import {
    appState,
    effectiveViewMode,
    markDisplayed,
    refreshFeeds,
    refreshPanel,
    setHideReadItems,
    setSort,
    setViewMode,
    toggleAutoRead,
    toggleHideEmptyFeeds,
    unsubscribe,
    currentTitle,
    unreadCount,
  } from '../state.svelte.js'
  import { goto } from '$app/navigation'
  import { api } from '../api.js'

  const PANEL_ID = 'feed-menu'

  // A setting that is in its affirmative state (enabled, hidden) carries the accent
  // fill. Note this follows the row's own value, not the underlying boolean: blue on
  // "Auto-read: disabling" would read as a contradiction.
  const TOGGLE_ON = 'bg-accent/15 hover:bg-accent/20 active:bg-accent/25'

  const search = createSearch()

  let triggerEl: HTMLButtonElement | undefined = $state()
  let panelEl: HTMLDialogElement | undefined = $state()
  let open = $state(false)

  const feedId = $derived(appState.filter.feedId)
  // Rename/unsubscribe/sort/auto-read only mean something for one feed — Latest,
  // Starred and category views are aggregates.
  const isFeedView = $derived(feedId != null && feedId !== '')
  const searchActive = $derived(Boolean(appState.filter.search))
  const autoReadOff = $derived(
    (appState.userPrefs.disabledAutoReadFeeds ?? []).includes(feedId as never),
  )

  let renameOpen = $state(false)
  let renameTitle = $state('')

  const isDesktop = () => matchMedia('(min-width: 48rem)').matches

  // ---- Placement ----

  /** Size and place the panel from the trigger's current rect. */
  function place() {
    const trigger = triggerEl
    const panel = panelEl
    if (!trigger || !panel) return
    const { top, left, width, maxHeight } = computePopoverPlacement({
      rect: trigger.getBoundingClientRect(),
      viewportWidth: window.visualViewport?.width ?? window.innerWidth,
      viewportHeight: window.visualViewport?.height ?? window.innerHeight,
      isDesktop: isDesktop(),
    })
    panel.style.top = `${top}px`
    panel.style.left = `${left}px`
    panel.style.width = `${width}px`
    panel.style.maxHeight = `${maxHeight}px`
  }

  // A window resize moves the trigger, but so can a layout change with no resize
  // — typing in the search box adds the 🔍 chip to the trigger. The observer
  // covers both, so the panel can't end up stranded behind the toolbar.
  let triggerObserver: ResizeObserver | null = null

  function watchTrigger() {
    window.addEventListener('resize', place)
    if (typeof ResizeObserver !== 'undefined' && triggerEl) {
      triggerObserver = new ResizeObserver(place)
      triggerObserver.observe(triggerEl)
    }
  }

  function unwatchTrigger() {
    window.removeEventListener('resize', place)
    triggerObserver?.disconnect()
    triggerObserver = null
  }

  $effect(() => () => unwatchTrigger())

  function openPanel() {
    const panel = panelEl
    if (!panel || panel.open) return
    place()
    panel.showModal()
    open = true
    watchTrigger()
  }

  /** Also fires for Escape, so this is the single teardown point. */
  function onClose() {
    open = false
    unwatchTrigger()
    renameOpen = false
  }

  /**
   * A click whose target is the dialog itself landed on the backdrop — the classic
   * tap-outside-to-dismiss. Nothing behind the backdrop is reachable anyway: a
   * modal makes the rest of the document inert, so only the backdrop takes a tap.
   */
  function onPanelClick(evt: MouseEvent) {
    if (evt.target === panelEl) closePanel()
  }

  function closePanel() {
    if (panelEl?.open) panelEl.close()
  }

  /** Every row dismisses the panel, so the action runner owns that. */
  async function runAndClose(action: () => Promise<unknown> | unknown) {
    try {
      await action()
    } finally {
      closePanel()
    }
  }

  // ---- Actions ----

  function onMarkAllRead() {
    markDisplayed()
    closePanel()
  }

  const onRefresh = () => runAndClose(() => refreshFeeds())
  const onViewMode = () =>
    runAndClose(() => setViewMode(effectiveViewMode() === 'expanded' ? 'list' : 'expanded'))
  const onSort = () =>
    runAndClose(() => setSort((appState.filter.sort ?? 'oldest') === 'newest' ? 'oldest' : 'newest'))
  const onToggleAutoRead = () => runAndClose(() => toggleAutoRead(feedId as never))
  const onHideEmptyFeeds = () => runAndClose(() => toggleHideEmptyFeeds())
  const onHideReadItems = () =>
    runAndClose(() => setHideReadItems(!(appState.filter.hideReadItems ?? true)))
  const onClearSearch = () => runAndClose(() => search.clearSearch())

  function startRename() {
    renameTitle = currentTitle()
    renameOpen = true
  }

  function cancelRename() {
    renameOpen = false
    renameTitle = ''
  }

  async function saveRename() {
    const id = feedId
    const title = renameTitle.trim()
    if (id == null || id === '' || !title) return
    await api.renameFeed(id as never, title)
    // Through the shared snapshot helper: keeps the active feed in the sidebar
    // and refreshes the title cache the header falls back to.
    await refreshPanel()
    renameOpen = false
    closePanel()
  }

  function onRenameKeydown(evt: KeyboardEvent) {
    if (evt.key !== 'Escape') return
    // Escape is also the dialog's dismiss key. Claim it while the rename field
    // is what's being escaped; if a browser still closes the panel, the toggle
    // handler cancels the rename anyway, so the worst case is a coarser escape.
    evt.preventDefault()
    evt.stopPropagation()
    cancelRename()
  }

  async function onUnsubscribe() {
    const id = feedId
    if (id == null || id === '') return
    if (!confirm('Unsubscribe from this feed?')) return
    await unsubscribe(id as never)
    closePanel()
    await goto('/')
  }

  async function onLogout() {
    await api.logout()
    closePanel()
    await goto('/login')
  }
</script>

<div class="min-w-0 flex-1 md:flex-none md:mr-auto">
  <button
    bind:this={triggerEl}
    type="button"
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-controls={PANEL_ID}
    data-testid="feed-menu-trigger"
    class="w-full md:w-auto min-h-11 min-w-0 flex items-center gap-x-2 px-3 py-2 border border-line rounded-lg bg-white hover:bg-surface active:bg-line leading-none text-left"
    onclick={openPanel}
  >
    <span class="min-w-0 flex-1 truncate font-medium">{currentTitle()}</span>
    {#if unreadCount() != null}
      <span
        data-testid="feed-menu-count"
        class="shrink-0 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent"
      >
        {unreadCount()}
      </span>
    {/if}
    {#if searchActive}
      <span class="shrink-0 max-w-24 truncate text-xs text-muted" title={appState.filter.search}>
        &#128269; {appState.filter.search}
      </span>
    {/if}
    <span class="shrink-0 text-xs text-muted" aria-hidden="true">&#9662;</span>
  </button>

  <dialog
    id={PANEL_ID}
    bind:this={panelEl}
    tabindex="-1"
    aria-label="Feed actions and settings"
    class="inset-auto m-0 max-w-none max-h-none bg-white border border-line rounded-xl shadow-xl text-sm overflow-y-auto overscroll-contain backdrop:bg-black/40"
    onclick={onPanelClick}
    onclose={onClose}
  >
    {#if renameOpen}
      <form
        class="p-3 flex flex-col gap-2"
        onsubmit={(e) => {
          e.preventDefault()
          void saveRename()
        }}
      >
        <label for="feed-rename" class="text-xs font-semibold uppercase tracking-wide text-muted">
          Rename feed
        </label>
        <input
          id="feed-rename"
          type="text"
          use:autofocus
          class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
          bind:value={renameTitle}
          onkeydown={onRenameKeydown}
        />
        <div class="flex gap-2">
          <button
            type="submit"
            class="flex-1 min-h-11 rounded-lg bg-accent text-white font-medium cursor-pointer hover:brightness-95 active:brightness-90"
          >
            Save
          </button>
          <button
            type="button"
            class="flex-1 min-h-11 rounded-lg bg-gray-50 text-ink cursor-pointer hover:bg-gray-100 active:bg-gray-200"
            onclick={cancelRename}
          >
            Cancel
          </button>
        </div>
      </form>
    {:else}
      <div class="flex flex-col">
        <!-- Search: the only one on mobile, since the toolbar box is desktop
             only. "Clear search" lives with it and is equally hidden on desktop,
             where the toolbar box itself is the way to clear. -->
        <div class="md:hidden p-2 flex flex-col gap-1 border-b border-line">
          <input
            type="search"
            placeholder="Search…"
            class="w-full min-h-11 px-3 py-2 border border-line rounded-lg"
            bind:value={search.searchText}
            oninput={search.onSearchInput}
          />
          {#if searchActive}
            <button type="button" class="menu-row" onclick={onClearSearch}>Clear search</button>
          {/if}
        </div>

        <!-- The one primary action on this surface. -->
        <div class="p-2 border-b border-line">
          <button
            type="button"
            class="w-full min-h-12 flex items-center justify-center gap-x-2 rounded-lg bg-accent text-white font-semibold cursor-pointer hover:brightness-95 active:brightness-90 disabled:opacity-60"
            onclick={onMarkAllRead}
          >
            <span aria-hidden="true">&#10003;</span>
            <span>Mark all read</span>
          </button>
        </div>

        <!-- Every setting in one group, each reading as name: value, laid out in
             the same two-up grid as the commands below. The count is odd (five in
             a feed view, three in an aggregate), so the last row has a spare
             cell; it is left empty rather than stretched, which keeps every
             button the same width. Sort and read-items are omitted while a
             search is active: search is always newest-first across both read
             buckets, so those rows would contradict the list. -->
        <div class="p-2 grid grid-cols-2 gap-1 border-b border-line">
          <button type="button" class="menu-row" onclick={onViewMode}>
            View: {effectiveViewMode()}
          </button>
          {#if isFeedView && !searchActive}
            <button type="button" class="menu-row" onclick={onSort}>
              Sort: {(appState.filter.sort ?? 'oldest') === 'oldest' ? 'oldest first' : 'newest first'}
            </button>
          {/if}
          {#if isFeedView}
            <button
              type="button"
              class="menu-row {autoReadOff ? '' : TOGGLE_ON}"
              aria-pressed={autoReadOff}
              onclick={onToggleAutoRead}
            >
              Auto-read: {autoReadOff ? 'disabled' : 'enabled'}
            </button>
          {/if}
          <button
            type="button"
            class="menu-row {(appState.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS) ? TOGGLE_ON : ''}"
            aria-pressed={(appState.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS) === true}
            onclick={onHideEmptyFeeds}
          >
            Empty feeds: {(appState.userPrefs.hideEmptyFeeds ?? DEFAULT_HIDE_EMPTY_FEEDS) ? 'hidden' : 'shown'}
          </button>
          {#if !searchActive}
            <button
              type="button"
              class="menu-row {appState.filter.hideReadItems ?? true ? TOGGLE_ON : ''}"
              aria-pressed={appState.filter.hideReadItems ?? true}
              onclick={onHideReadItems}
            >
              Read items: {appState.filter.hideReadItems ?? true ? 'hidden' : 'shown'}
            </button>
          {/if}
        </div>

        <!-- Commands, in a two-up grid: always an even count (four in a feed view,
             two in an aggregate), so no cell is ever left half-empty. The two
             "leave" actions pair on the last row. -->
        <div class="p-2 grid grid-cols-2 gap-1">
          <button type="button" class="menu-row" onclick={onRefresh}>Refresh feeds</button>
          {#if isFeedView}
            <button type="button" class="menu-row" onclick={startRename}>Rename feed…</button>
            <button type="button" class="menu-row text-red-600" onclick={onUnsubscribe}>Unsubscribe</button>
          {/if}
          <button type="button" class="menu-row" onclick={onLogout}>Sign out</button>
        </div>
      </div>
    {/if}
  </dialog>
</div>
