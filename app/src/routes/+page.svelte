<script lang="ts">
  // ReaderView — the reading surface: toolbar, sidebar (static column on md+,
  // off-canvas drawer on mobile), drag-to-resize handle, scroll container.
  // Ported from the old ReaderView.vue; the identity filter comes from the URL.
  import { onMount } from 'svelte'
  import { page } from '$app/state'

  import TopToolbar from '../client/components/TopToolbar.svelte'
  import FeedPanel from '../client/components/FeedPanel.svelte'
  import EntryList from '../client/components/EntryList.svelte'
  import {
    appState,
    loadBootstrap,
    loadEnd,
    reloadEntries,
    setFilter,
    setViewMode,
    startIdleRefresh,
  } from '../client/state.svelte.js'
  import { attachKeyboard } from '../client/keyboard.js'
  import { scrollToEntry } from '../client/nav.js'
  import { parseFilterFromUrl } from '../shared/filter'

  const isDesktop = $state({ value: false })
  let sidebarOpen = $state(false)

  let scrollEl: HTMLDivElement | undefined = $state()

  const initialFilter = parseFilterFromUrl(Object.fromEntries(page.url.searchParams))
  setFilter(initialFilter)
  let lastFilter = initialFilter

  onMount(() => {
    const mql = matchMedia('(min-width: 48rem)')
    const onChange = () => (isDesktop.value = mql.matches)
    onChange()
    mql.addEventListener('change', onChange)

    void loadBootstrap(initialFilter)
    const stopKeys = attachKeyboard(() => {
      setViewMode(appState.viewModeOverride === 'expanded' ? 'list' : 'expanded')
    })
    const stopIdle = startIdleRefresh()
    return () => {
      stopKeys()
      stopIdle()
      mql.removeEventListener('change', onChange)
    }
  })

  // Nav link in the drawer: close the drawer, reload only when the identity
  // filter actually changed (old route-watcher behavior).
  $effect(() => {
    const next = parseFilterFromUrl(Object.fromEntries(page.url.searchParams))
    if (
      next.feedId !== lastFilter.feedId ||
      next.categoryId !== lastFilter.categoryId ||
      next.starred !== lastFilter.starred ||
      next.search !== lastFilter.search
    ) {
      lastFilter = next
      sidebarOpen = false
      setFilter(next)
      void reloadEntries(next)
    }
  })

  // A fresh list starts at the top (nav, feed re-click, mark-all-read, refresh —
  // anything that bumps pageGen).
  let lastGen = 0
  $effect(() => {
    if (appState.pageGen !== lastGen) {
      lastGen = appState.pageGen
      if (scrollEl) scrollEl.scrollTop = 0
    }
  })

  // Scroll-into-view for keyboard nav; one DOM effect for the whole app.
  $effect(() => {
    const id = appState.navRequest
    if (id != null) {
      scrollToEntry(id)
      appState.navRequest = null
    }
  })

  // Mark userHasScrolled + end-of-list state on the entry-list scroll container.
  // atListEnd gates the idle-time tail recheck (loadEnd).
  function onListScroll() {
    const el = scrollEl
    // A scroll landing at scrollTop 0 is our own programmatic reset when a
    // fresh list replaces the old one — not user intent. Without this, opening
    // a feed arms the auto-read sweep and marks its first entry read.
    if (el && el.scrollTop !== 0) appState.userHasScrolled = true
    if (el) appState.atListEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 200
  }

  // Desktop drag-to-resize of the sidebar (old useSidebarResize port): pure
  // pointer events + a CSS var the grid column reads.
  const MIN_W = 200
  const MAX_W = 480
  const STORAGE_KEY = 'mf-sidebar-w'

  function sidebarResize(node: HTMLElement) {
    let startX = 0
    let startW = 280
    const setW = (w: number) =>
      document.documentElement.style.setProperty('--sidebar-w', `${Math.min(MAX_W, Math.max(MIN_W, w))}px`)
    const onPointerDown = (e: PointerEvent) => {
      e.preventDefault()
      startX = e.clientX
      startW =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w')) || 280
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (ev: PointerEvent) => setW(startW + (ev.clientX - startX))
      const up = () => {
        document.removeEventListener('pointermove', move)
        document.removeEventListener('pointerup', up)
        document.removeEventListener('pointercancel', up)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        try {
          localStorage.setItem(
            STORAGE_KEY,
            getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
          )
        } catch {
          // ignore
        }
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const n = parseInt(saved, 10)
        if (n > 0) setW(n)
      }
    } catch {
      // ignore
    }
    node.addEventListener('pointerdown', onPointerDown)
    return {
      destroy() {
        node.removeEventListener('pointerdown', onPointerDown)
      },
    }
  }
</script>

<div class="grid grid-rows-[auto_1fr] app-container flex-1 min-h-0">
  <TopToolbar onToggleSidebar={() => (sidebarOpen = !sidebarOpen)} />

  <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
    <!-- Sidebar: static column on md+, off-canvas drawer on mobile toggled
         by display. The drawer is hidden until opened; on desktop it renders
         as a static column. -->
    <div
      class="app-sidebar fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto {sidebarOpen ||
      isDesktop.value
        ? ''
        : 'hidden'}"
    >
      <div class="flex justify-end md:hidden p-2">
        <button
          type="button"
          class="px-2 py-2 border border-gray-300 rounded-md"
          onclick={() => (sidebarOpen = false)}
        >
          ✕
        </button>
      </div>
      <FeedPanel />
    </div>

    <!-- Scrim on mobile while the drawer is open. -->
    {#if sidebarOpen && !isDesktop.value}
      <div
        class="fixed inset-0 z-20 bg-black/30 md:hidden"
        onclick={() => (sidebarOpen = false)}
        role="presentation"
      ></div>
    {/if}

    <!-- Drag-to-resize handle (desktop only): sits in the grid gap. -->
    <div
      id="sidebar-resize"
      use:sidebarResize
      class="absolute top-0 bottom-0 z-40 hidden md:block cursor-col-resize touch-none hover:bg-cyan-700/20"
      style="left: calc(var(--sidebar-w) + 3px); width: 6px;"
      aria-hidden="true"
    ></div>

    <div bind:this={scrollEl} class="overflow-y-auto min-h-0" data-testid="entry-scroll" onscroll={onListScroll}>
      <EntryList />
    </div>
  </div>
</div>
