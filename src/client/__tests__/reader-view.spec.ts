// ReaderView scroll gating: userHasScrolled must only be armed by real user
// scrolling. The programmatic scrollTop reset that fires when a new page
// replaces the list (feed open, mark-all-read, toolbar refresh) emits a
// scroll event landing at scrollTop 0 — that must NOT arm the auto-read
// sweep, or opening a feed would mark its first entry read.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {} }),
}))
vi.mock('@/client/composables/keyboard', () => ({ useKeyboard: () => {} }))
vi.mock('@/client/composables/resize', () => ({ useSidebarResize: () => {} }))
vi.mock('@/client/composables/polling', () => ({ useIdleRefresh: () => {} }))

const bootstrapMock = vi.fn<() => Promise<unknown>>()

vi.mock('@/client/api/reader', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/client/api/reader')>()
  return {
    ...mod,
    createMinifluxReaderApi: () =>
      ({
        bootstrap: (...args: unknown[]) =>
          (bootstrapMock as (...a: unknown[]) => unknown)(...args),
      }) as unknown as ReturnType<typeof mod.createMinifluxReaderApi>,
  }
})

import ReaderView from '@/client/views/ReaderView.vue'
import { useReaderStore } from '@/client/stores/reader'

beforeEach(() => {
  setActivePinia(createPinia())
  bootstrapMock.mockReset()
  bootstrapMock.mockResolvedValue({
    entries: [],
    nextCursor: null,
    hasMore: false,
    feedPrefs: {},
    feeds: [],
    categories: [],
    counters: {},
    userPrefs: {},
  } as unknown)
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function mountView() {
  return mount(ReaderView, {
    global: {
      stubs: {
        TopToolbar: { template: '<div />' },
        FeedPanel: { template: '<div />' },
        EntryList: { template: '<div />' },
      },
    },
  })
}

describe('ReaderView userHasScrolled gating', () => {
  it('does not arm on a scroll event that lands at the top (feed-open reset)', async () => {
    const reader = useReaderStore()
    const wrapper = mountView()
    await vi.waitFor(() => expect(reader.pageGen).toBeGreaterThan(0))

    const el = wrapper.get('[data-testid="entry-scroll"]').element
    let scrollTop = 0
    Object.defineProperty(el, 'scrollTop', { get: () => scrollTop, configurable: true })

    // The pageGen watcher's programmatic reset emits a scroll event at 0.
    el.dispatchEvent(new Event('scroll'))
    expect(reader.userHasScrolled).toBe(false)

    // A real scroll moves the container off the top → arms.
    scrollTop = 300
    el.dispatchEvent(new Event('scroll'))
    expect(reader.userHasScrolled).toBe(true)

    wrapper.unmount()
  })

  it('arms on a scroll gesture even if it ends back at the top', async () => {
    const reader = useReaderStore()
    const wrapper = mountView()
    await vi.waitFor(() => expect(reader.pageGen).toBeGreaterThan(0))

    const el = wrapper.get('[data-testid="entry-scroll"]').element
    let scrollTop = 0
    Object.defineProperty(el, 'scrollTop', { get: () => scrollTop, configurable: true })

    // A genuine gesture passes through intermediate positions before
    // returning to 0 — the mid-gesture event arms.
    scrollTop = 50
    el.dispatchEvent(new Event('scroll'))
    scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
    expect(reader.userHasScrolled).toBe(true)

    wrapper.unmount()
  })
})
