// FeedMenu: covers which rows the popover offers for which filter, and the
// trigger's count pill. jsdom has no popover implementation, so open/close and
// placement are out of reach here — the placement math is unit-tested in
// src/shared/popover.test.ts, and the rest needs a real browser.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createMemoryHistory, createRouter } from 'vue-router'

import FeedMenu from '@/client/components/FeedMenu.vue'
import { useFeedsStore } from '@/client/stores/feeds'
import { useReaderStore } from '@/client/stores/reader'
import { vFocus } from '@/client/directives/focus'

// jsdom ships no matchMedia; useMediaQuery() needs one on mount.
vi.stubGlobal('matchMedia', (query: string) => ({
  matches: false,
  media: query,
  addEventListener: () => {},
  removeEventListener: () => {},
}))

// jsdom implements <dialog> as an element but not its open/close methods. These
// stubs cover this component's wiring; what a modal actually buys — the rest of
// the document going inert, and the ::backdrop scrim — jsdom cannot verify.
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute('open', '')
}
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

function mountMenu() {
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  return mount(FeedMenu, {
    global: { directives: { focus: vFocus }, plugins: [router] },
  })
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('FeedMenu', () => {
  it('is a modal dialog with a trigger that controls it', () => {
    const wrapper = mountMenu()
    const panel = wrapper.find('#feed-menu')
    expect(panel.element.tagName).toBe('DIALOG')
    expect(panel.attributes('aria-label')).toBe('Feed actions and settings')
    const trigger = wrapper.find('[data-testid="feed-menu-trigger"]')
    expect(trigger.attributes('aria-haspopup')).toBe('dialog')
    expect(trigger.attributes('aria-controls')).toBe('feed-menu')
  })

  it('opens modally and dismisses on a backdrop click', async () => {
    const wrapper = mountMenu()
    const panel = wrapper.find('#feed-menu')
    const el = panel.element as HTMLDialogElement
    const trigger = wrapper.find('[data-testid="feed-menu-trigger"]')

    await trigger.trigger('click')
    expect(el.open).toBe(true)
    expect(trigger.attributes('aria-expanded')).toBe('true')

    // A click whose target is the dialog itself landed on the scrim. The close
    // event is queued, so let a task turn before checking the derived state.
    await panel.trigger('click')
    expect(el.open).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(trigger.attributes('aria-expanded')).toBe('false')
  })

  it('offers feed-specific settings only in a feed view', () => {
    const reader = useReaderStore()
    reader.setFilter({ status: 'unread', feedId: 7 })
    const feedText = mountMenu().text()
    expect(feedText).toContain('Rename feed…')
    expect(feedText).toContain('Unsubscribe')
    expect(feedText).toContain('Auto-read:')
    expect(feedText).toContain('Sort:')

    reader.setFilter({ status: 'unread', starred: true })
    const starredText = mountMenu().text()
    expect(starredText).not.toContain('Rename feed…')
    expect(starredText).not.toContain('Unsubscribe')
    expect(starredText).not.toContain('Auto-read:')
    expect(starredText).not.toContain('Sort:')
  })

  it('always offers the settings and the commands', () => {
    useReaderStore().setFilter({ status: 'unread', starred: true })
    const text = mountMenu().text()
    for (const label of [
      'Mark all read',
      'View:',
      'Empty feeds:',
      'Read items:',
      'Refresh feeds',
      'Sign out',
    ]) {
      expect(text).toContain(label)
    }
  })

  it('shows the unread count, except where it is not meaningful', () => {
    const feeds = useFeedsStore()
    const reader = useReaderStore()
    feeds.applyCounters({ 7: 12 })

    reader.setFilter({ status: 'unread', feedId: 7 })
    expect(mountMenu().find('[data-testid="feed-menu-count"]').text()).toBe('12')

    // Starred has no per-feed unread breakdown, so unreadCount is null.
    reader.setFilter({ status: 'unread', starred: true })
    expect(mountMenu().find('[data-testid="feed-menu-count"]').exists()).toBe(false)
  })

  it('offers "Clear search" only while a search is active', () => {
    const reader = useReaderStore()
    reader.setFilter({ status: 'unread' })
    expect(mountMenu().text()).not.toContain('Clear search')

    reader.setFilter({ status: 'unread', search: 'rust' })
    expect(mountMenu().text()).toContain('Clear search')
  })

  it('keeps every setting above every command', () => {
    useReaderStore().setFilter({ status: 'unread', feedId: 7 })
    const text = mountMenu().text()
    // Top to bottom: the primary action, the settings group, then the commands.
    expect(text.indexOf('Mark all read')).toBeLessThan(text.indexOf('View:'))
    expect(text.indexOf('Sort:')).toBeLessThan(text.indexOf('Auto-read:'))
    expect(text.indexOf('Read items:')).toBeLessThan(text.indexOf('Refresh feeds'))
    expect(text.indexOf('Refresh feeds')).toBeLessThan(text.indexOf('Rename feed…'))
    expect(text.indexOf('Rename feed…')).toBeLessThan(text.indexOf('Unsubscribe'))
    expect(text.indexOf('Unsubscribe')).toBeLessThan(text.indexOf('Sign out'))
  })

  it('leaves the last grid cell empty instead of stretching a button into it', () => {
    useReaderStore().setFilter({ status: 'unread', feedId: 7 })
    // The settings group has an odd count, so its last row has a spare cell. A
    // stretched button would be twice as wide as every other button in the grid.
    expect(mountMenu().html()).not.toContain('col-span-2')
  })

  it('fills the affirmative settings with the accent colour', () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.setFilter({ status: 'unread', feedId: 7 })
    reader.hideReadItems = true
    feeds.hideEmptyFeeds = false
    feeds.disabledAutoReadFeeds = []

    // Auto-read enabled and Read items hidden are affirmative; Empty feeds shown
    // is not, so it keeps the neutral fill.
    const filled = mountMenu()
      .findAll('button[aria-pressed]')
      .filter((b) => b.classes().includes('bg-accent/15'))
    expect(filled).toHaveLength(2)
    expect(filled.map((b) => b.text())).toEqual(['Auto-read: enabled', 'Read items: hidden'])
  })

  it('spells each setting out as name: value rather than showing a glyph', () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.setFilter({ status: 'unread', feedId: 7 })

    feeds.hideEmptyFeeds = true
    feeds.disabledAutoReadFeeds = [7]
    const on = mountMenu().text()
    expect(on).toContain('Empty feeds: hidden')
    expect(on).toContain('Auto-read: disabled')
    expect(on).toContain('View: expanded')
    expect(on).toContain('Sort: oldest first')

    feeds.hideEmptyFeeds = false
    feeds.disabledAutoReadFeeds = []
    const off = mountMenu().text()
    expect(off).toContain('Empty feeds: shown')
    expect(off).toContain('Auto-read: enabled')
  })

  it('keeps the toggles marked as pressed for assistive tech', () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.setFilter({ status: 'unread', feedId: 7 })
    feeds.hideEmptyFeeds = true

    // Only the three real toggles carry aria-pressed; the value-cycling rows
    // (view, sort) communicate their state in their label instead.
    const toggles = mountMenu().findAll('button[aria-pressed]')
    expect(toggles).toHaveLength(3)
    expect(toggles.map((b) => b.attributes('aria-pressed'))).toEqual(['false', 'true', 'true'])
  })
})