import { createEffect, createMemo, createSignal, onSettled } from 'solid-js'
import { useLocation } from '@solidjs/router'

import { parseFilterFromUrl } from '../shared/filter'
import type { EntriesFilter } from '../shared/filter'
import { attachKeyboard } from '../lib/keyboard'
import { scrollToEntry } from '../lib/nav'
import {
  effectiveViewMode,
  loadBootstrap,
  reader,
  reloadEntries,
  setFilter,
  setReader,
  setViewMode,
  startIdleRefresh,
} from '../lib/state'
import { FeedPanel } from '../components/FeedPanel'
import { EntryList } from '../components/EntryList'
import { TopToolbar } from '../components/TopToolbar'

const identityKey = (filter: EntriesFilter): string =>
  [filter.feedId ?? '', filter.categoryId ?? '', filter.starred ? '1' : '', filter.search ?? ''].join(
    '|',
  )

/**
 * The reading surface: toolbar, sidebar (a static column on md+, an off-canvas
 * drawer on mobile), drag-to-resize handle, scroll container.
 *
 * The URL is the view state — which feed, category, section or search — so a
 * reload or the back button lands where the user left it. Everything else
 * (sorting, expansion, read-marking) is session state and never leaves the tab.
 */
export const ReaderPage = () => {
  const location = useLocation()
  const query = createMemo(() => location.query)
  const filterFromUrl = () => {
    const single: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(query())) {
      single[key] = Array.isArray(value) ? value[0] : value
    }
    return parseFilterFromUrl(single)
  }

  const [isDesktop, setIsDesktop] = createSignal(false)
  const [sidebarOpen, setSidebarOpen] = createSignal(false)

  let scrollEl: HTMLDivElement | undefined

  const initialFilter = filterFromUrl()
  let lastFilter: EntriesFilter = initialFilter

  // First paint and teardown. `onSettled` is Solid 2's onMount: it runs after
  // the initial reactive settle, and the function it returns is the cleanup.
  onSettled(() => {
    setFilter(initialFilter)

    const mql = matchMedia('(min-width: 48rem)')
    const onChange = () => setIsDesktop(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)

    void loadBootstrap(initialFilter)
    const stopKeys = attachKeyboard(() => {
      setViewMode(effectiveViewMode() === 'expanded' ? 'list' : 'expanded')
    })
    const stopIdle = startIdleRefresh()

    return () => {
      stopKeys()
      stopIdle()
      mql.removeEventListener('change', onChange)
    }
  })

  // Mobile drawer: picking any sidebar entry closes it (rows navigate by
  // replacing the identity filter — this covers every selection path).
  createEffect(
    () => [reader.filter.feedId, reader.filter.categoryId, reader.filter.starred, reader.filter.search],
    () => {
      setSidebarOpen(false)
    },
  )

  // Nav link in the drawer: close the drawer, reload only when the identity
  // filter actually changed (old route-watcher behavior).
  createEffect(
    () => identityKey(filterFromUrl()),
    () => {
      const next = filterFromUrl()
      if (identityKey(next) === identityKey(lastFilter)) {
        setSidebarOpen(false)
        return
      }
      lastFilter = next
      setSidebarOpen(false)
      setFilter(next)
      void reloadEntries(next)
    },
  )

  // A fresh list starts at the top (nav, feed re-click, mark-all-read, refresh —
  // anything that bumps pageGen).
  let lastGen = 0
  createEffect(
    () => reader.pageGen,
    (gen) => {
      if (gen !== lastGen) {
        lastGen = gen
        if (scrollEl) scrollEl.scrollTop = 0
      }
    },
  )

  // Scroll-into-view for keyboard nav; one effect for the whole app.
  createEffect(
    () => reader.navRequest,
    (id) => {
      if (id == null) return
      scrollToEntry(id)
      setReader((state) => { state.navRequest = null })
    },
  )

  // Mark userHasScrolled + end-of-list state on the entry-list scroll container.
  // atListEnd gates the idle-time tail recheck (checkTail).
  const onListScroll = (): void => {
    const element = scrollEl
    // A scroll landing at scrollTop 0 is our own programmatic reset when a fresh
    // list replaces the old one — not user intent. Without this, opening a feed
    // arms the auto-read sweep and marks its first entry read.
    if (element && element.scrollTop !== 0) setReader((state) => { state.userHasScrolled = true })
    if (element) {
      const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 200
      setReader((state) => {
        state.atListEnd = atEnd
      })
    }
  }

  // Desktop drag-to-resize of the sidebar: pure pointer events + a CSS var the
  // grid column reads.
  const MIN_W = 200
  const MAX_W = 480
  const STORAGE_KEY = 'mf-sidebar-w'

  const sidebarResize = (node: HTMLElement): (() => void) => {
    let startX = 0
    let startW = 280
    const setWidth = (width: number) =>
      document.documentElement.style.setProperty(
        '--sidebar-w',
        `${Math.min(MAX_W, Math.max(MIN_W, width))}px`,
      )
    const onPointerDown = (event: PointerEvent) => {
      event.preventDefault()
      startX = event.clientX
      startW =
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
        ) || 280
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      const move = (moveEvent: PointerEvent) => setWidth(startW + (moveEvent.clientX - startX))
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
          // ignore: a full quota or a private window just means no remembered width
        }
      }
      document.addEventListener('pointermove', move)
      document.addEventListener('pointerup', up)
      document.addEventListener('pointercancel', up)
    }
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const width = Number.parseInt(saved, 10)
        if (width > 0) setWidth(width)
      }
    } catch {
      // ignore
    }
    node.addEventListener('pointerdown', onPointerDown)
    return () => node.removeEventListener('pointerdown', onPointerDown)
  }

  return (
    <div class="grid grid-rows-[auto_1fr] app-container flex-1 min-h-0">
      <TopToolbar onToggleSidebar={() => setSidebarOpen(!sidebarOpen())} />

      <div class="relative grid grid-cols-1 md:grid-cols-[var(--sidebar-w)_1fr] gap-x-3 min-h-0 overflow-hidden">
        {/* Sidebar: static column on md+, off-canvas drawer on mobile toggled by
            display. The drawer is hidden until opened. */}
        <div
          class={[
            'app-sidebar fixed inset-y-0 left-0 z-30 w-[var(--sidebar-w)] bg-white shadow-xl md:shadow-none md:static md:bg-transparent md:block md:m-0 overflow-y-auto',
            { hidden: !sidebarOpen() && !isDesktop() },
          ]}
        >
          <div class="flex justify-end md:hidden p-2">
            <button
              type="button"
              class="px-2 py-2 border border-gray-300 rounded-md"
              onClick={() => setSidebarOpen(false)}
            >
              ✕
            </button>
          </div>
          <FeedPanel />
        </div>

        {/* Scrim on mobile while the drawer is open. */}
        {sidebarOpen() && !isDesktop() && (
          <div
            class="fixed inset-0 z-20 bg-black/30 md:hidden"
            onClick={() => setSidebarOpen(false)}
            role="presentation"
          />
        )}

        {/* Drag-to-resize handle (desktop only): sits in the grid gap. */}
        <div
          id="sidebar-resize"
          ref={sidebarResize}
          class="absolute top-0 bottom-0 z-40 hidden md:block cursor-col-resize touch-none hover:bg-cyan-700/20"
          style="left: calc(var(--sidebar-w) + 3px); width: 6px;"
          aria-hidden="true"
        />

        <div
          ref={(element) => {
            scrollEl = element
          }}
          class="overflow-y-auto min-h-0"
          data-testid="entry-scroll"
          onScroll={onListScroll}
        >
          <EntryList />
        </div>
      </div>
    </div>
  )
}

export default ReaderPage
