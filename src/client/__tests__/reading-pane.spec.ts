import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import EntryItem from '@/client/components/EntryItem.vue'
import { useReaderStore } from '@/client/stores/reader'
import { vTrackTop } from '@/client/directives/track-top'
import { vIntersectLine } from '@/client/directives/intersect-line'
import { vIntersect } from '@/client/directives/intersect'
import type { MinifluxEntry } from '@/shared/types'

// --- IntersectionObserver mock: records instances + exposes a deterministic
// fire() helper so tests can drive the real directive wiring ---
class MockIntersectionObserver implements IntersectionObserver {
  static instances: MockIntersectionObserver[] = []
  readonly root: Element | Document | null = null
  readonly rootMargin = '0px'
  readonly thresholds: ReadonlyArray<number> = [0]

  constructor(
    private cb: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.root = options?.root ?? null
    this.rootMargin = options?.rootMargin ?? '0px'
    this.thresholds = (options?.threshold as ReadonlyArray<number>) ?? [0]
    MockIntersectionObserver.instances.push(this)
  }

  observe() {}
  unobserve() {}
  disconnect() {}

  /** Fire an intersection batch for a target element. */
  fire(target: Element, isIntersecting: boolean, top = 100, bottom = 200) {
    const batch = [
      {
        target,
        isIntersecting,
        rootBounds: new DOMRect(0, 0, 800, 600),
        boundingClientRect: new DOMRect(0, top, 100, bottom - top),
        intersectionRatio: isIntersecting ? 1 : 0,
      },
    ]
    this.cb(batch as unknown as IntersectionObserverEntry[], this)
  }
}

const globalDirectives = {
  'track-top': vTrackTop,
  'intersect-line': vIntersectLine,
  'intersect': vIntersect,
}

beforeEach(() => {
  setActivePinia(createPinia())
  MockIntersectionObserver.instances = []
  // Drop stale v-intersect-line members left attached to body by earlier
  // tests; the sweep skips disconnected elements.
  document.body.innerHTML = ''
  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const entry: MinifluxEntry = {
  id: 42,
  user_id: 1,
  feed_id: 7,
  title: 'A testing article',
  url: 'https://example.com/article',
  author: 'Tester',
  content: '<p>Hello <strong>world</strong></p>',
  published_at: new Date(Date.now() - 3_600_000).toISOString(),
  status: 'unread',
  starred: false,
  reading_time: 2,
  feed: { id: 7, user_id: 1, title: 'Test Feed', site_url: 'https://example.com', feed_url: 'https://example.com/rss', category: null },
}

/** Find the v-intersect observer (the infinite-scroll sentinel, 400px margin). */
function findObserver(marginPart: string): MockIntersectionObserver {
  const obs = MockIntersectionObserver.instances.find((o) =>
    String(o.rootMargin).includes(marginPart),
  )
  if (!obs) throw new Error(`no observer with margin ${marginPart}`)
  return obs
}

describe('EntryItem', () => {
  it('renders title, source, and reading content in expanded view', () => {
    const reader = useReaderStore()
    reader.viewMode = 'expanded'

    const wrapper = mount(EntryItem, {
      props: { entry },
      global: { directives: globalDirectives },
    })

    expect(wrapper.text()).toContain('A testing article')
    expect(wrapper.text()).toContain('Test Feed')
    expect(wrapper.html()).toContain('Hello <strong>world</strong>')
  })

  it('hides reading content in list view', () => {
    const reader = useReaderStore()
    reader.viewMode = 'list'

    const wrapper = mount(EntryItem, {
      props: { entry },
      global: { directives: globalDirectives },
    })

    expect(wrapper.text()).toContain('A testing article')
    expect(wrapper.find('.reading').exists()).toBe(false)
  })

  it('shows the keep-unread toggle and calls toggleRead on click', async () => {
    const reader = useReaderStore()
    const spy = vi.spyOn(reader, 'toggleRead').mockResolvedValue({} as never)

    const wrapper = mount(EntryItem, {
      props: { entry },
      global: { directives: globalDirectives },
    })

    await wrapper.find('button[title*="Keep unread"]').trigger('click')
    expect(spy).toHaveBeenCalledWith(42)
  })

  it('marks read on card click, exempt from the feed mark-read-on-scroll setting', async () => {
    const reader = useReaderStore()
    const autoReadSpy = vi.spyOn(reader, 'autoRead').mockResolvedValue({} as never)

    const wrapper = mount(EntryItem, {
      props: { entry },
      global: { directives: globalDirectives },
    })

    await wrapper.find('article').trigger('click')
    expect(autoReadSpy).toHaveBeenCalledWith(42, false, { ignoreFeedSetting: true })
  })
})

describe('v-intersect-line (auto-read)', () => {
  // rAF stub that runs the callback synchronously and returns undefined so
  // scheduleSweep's `rafId != null` guard never sees a pending frame — each
  // dispatched scroll runs its sweep immediately.
  function stubRafSync() {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return undefined as unknown as number
    })
  }

  function mountLine() {
    const Wrapper = {
      template: `<article v-intersect-line="{ entryId: 42, feedId: 7 }"></article>`,
    }
    // Attached to body: the scroll root resolves to document.body (no
    // [data-testid="entry-list"] ancestor here), and the sweep skips
    // disconnected elements.
    const wrapper = mount(Wrapper, {
      attachTo: document.body,
      global: { directives: globalDirectives },
    })
    vi.spyOn(document.body, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 800, 1000)) // band line at y=150
    return wrapper
  }

  function scroll() {
    document.body.dispatchEvent(new Event('scroll'))
  }

  it('fires once the top edge passes the band line, gated on userHasScrolled', () => {
    stubRafSync()
    const reader = useReaderStore()
    reader.viewMode = 'expanded'
    reader.entries = [entry]
    const autoReadSpy = vi.spyOn(reader, 'autoRead').mockResolvedValue({} as never)

    const wrapper = mountLine()
    const el = wrapper.element
    let elTop = 100 // already past the band line (150)
    vi.spyOn(el, 'getBoundingClientRect').mockImplementation(
      () => new DOMRect(0, elTop, 800, 100),
    )

    // Top edge is above the line, but the user hasn't scrolled → no fire.
    reader.userHasScrolled = false
    scroll()
    expect(autoReadSpy).not.toHaveBeenCalled()

    // After the user has scrolled → fires with viaScroll=true.
    reader.userHasScrolled = true
    scroll()
    expect(autoReadSpy).toHaveBeenCalledWith(42, true)

    // Fired members are dropped — further scrolls don't re-fire.
    elTop = 0
    scroll()
    expect(autoReadSpy).toHaveBeenCalledTimes(1)

    wrapper.unmount()
  })

  it('does not fire while the top edge is still below the band line', () => {
    stubRafSync()
    const reader = useReaderStore()
    reader.viewMode = 'expanded'
    reader.entries = [entry]
    const autoReadSpy = vi.spyOn(reader, 'autoRead').mockResolvedValue({} as never)

    const wrapper = mountLine()
    const el = wrapper.element
    vi.spyOn(el, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 300, 800, 100)) // top edge below the line

    reader.userHasScrolled = true
    scroll()
    expect(autoReadSpy).not.toHaveBeenCalled()

    wrapper.unmount()
  })
})

describe('v-intersect (infinite-scroll sentinel)', () => {
  it('calls loadEnd when the sentinel becomes visible', () => {
    const reader = useReaderStore()
    reader.hasMore = true
    const loadEndSpy = vi.spyOn(reader, 'loadEnd').mockResolvedValue()

    const Wrapper = {
      template: `<div><div v-intersect class="sentinel"></div></div>`,
    }
    const wrapper = mount(Wrapper, { global: { directives: globalDirectives } })
    const el = wrapper.element.querySelector('.sentinel')!

    const sentinelObs = findObserver('400px')
    sentinelObs.fire(el, true)
    expect(loadEndSpy).toHaveBeenCalled()
  })
})
