// autoRead is the single guarded entry point for marking entries read —
// scroll band, j/k/buttons, and card click all funnel into it. These tests
// pin the guard contract so no trigger can bypass it again.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useReaderStore } from '@/client/stores/reader'
import { useFeedsStore } from '@/client/stores/feeds'
import type { MinifluxEntry } from '@/shared/types'

function mk(overrides: Partial<MinifluxEntry> = {}): MinifluxEntry {
  return {
    id: 42,
    user_id: 1,
    feed_id: 7,
    title: 'entry',
    url: 'https://example.com/42',
    author: '',
    content: '',
    published_at: new Date(0).toISOString(),
    status: 'unread',
    starred: false,
    reading_time: 1,
    feed: { id: 7, user_id: 1, title: 'F', site_url: '', feed_url: '', category: null },
    ...overrides,
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('autoRead guard', () => {
  it('marks an unread entry read via an explicit trigger (default)', () => {
    const reader = useReaderStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'

    return reader.autoRead(42).then(() => {
      expect(reader.entries[0]!.status).toBe('read')
    })
  })

  it('blocks before the user has scrolled for the passive scroll trigger', async () => {
    const reader = useReaderStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    reader.userHasScrolled = false

    await reader.autoRead(42, true)

    expect(reader.entries[0]!.status).toBe('unread')
  })

  it('fires for the scroll trigger once the user has scrolled', async () => {
    const reader = useReaderStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    reader.userHasScrolled = true

    await reader.autoRead(42, true)

    expect(reader.entries[0]!.status).toBe('read')
  })

  it('blocks in list view regardless of trigger', async () => {
    const reader = useReaderStore()
    reader.entries = [mk()]
    reader.viewMode = 'list'
    reader.userHasScrolled = true

    await reader.autoRead(42, true)
    await reader.autoRead(42)

    expect(reader.entries[0]!.status).toBe('unread')
  })

  it('blocks feeds with auto-read disabled', async () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    feeds.disabledAutoReadFeeds = [7]

    await reader.autoRead(42)
    await reader.autoRead(42, true)

    expect(reader.entries[0]!.status).toBe('unread')
  })

  it('card click marks read even when the feed has auto-read disabled', async () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    feeds.disabledAutoReadFeeds = [7]

    await reader.autoRead(42, false, { ignoreFeedSetting: true })

    expect(reader.entries[0]!.status).toBe('read')
  })

  it('card click still respects keep-unread', async () => {
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    feeds.disabledAutoReadFeeds = [7]
    reader.keepUnreadIds = new Set([42])

    await reader.autoRead(42, false, { ignoreFeedSetting: true })

    expect(reader.entries[0]!.status).toBe('unread')
  })

  it('blocks explicitly kept-unread entries on every trigger', async () => {
    const reader = useReaderStore()
    reader.entries = [mk()]
    reader.viewMode = 'expanded'
    reader.keepUnreadIds = new Set([42])

    await reader.autoRead(42)
    await reader.autoRead(42, true)

    expect(reader.entries[0]!.status).toBe('unread')
  })

  it('never downgrades a read entry', async () => {
    const reader = useReaderStore()
    reader.entries = [mk({ status: 'read' })]
    reader.viewMode = 'expanded'

    await reader.autoRead(42)

    expect(reader.entries[0]!.status).toBe('read')
  })
})

describe('moveAndRead', () => {
  it('moves the anchor and auto-reads the destination', async () => {
    const reader = useReaderStore()
    reader.entries = [mk({ id: 1 }), mk({ id: 2 })]
    reader.currentId = 1
    reader.viewMode = 'expanded'

    reader.moveAndRead(1)

    expect(reader.currentId).toBe(2)
    await vi.waitFor(() => {
      expect(reader.entries[1]!.status).toBe('read')
    })
  })

  it('respects keep-unread on the destination', async () => {
    const reader = useReaderStore()
    reader.entries = [mk({ id: 1 }), mk({ id: 2 })]
    reader.currentId = 1
    reader.viewMode = 'expanded'
    reader.keepUnreadIds = new Set([2])

    reader.moveAndRead(1)

    expect(reader.currentId).toBe(2)
    await vi.waitFor(() => {
      expect(reader.entries[1]!.status).toBe('unread')
    })
  })
})
