// Pagination behavior of the reader store: loadMore must never terminate early
// on an all-duplicate page (bulk same-second publishes), and checkTail must
// extend the list with items that arrived past its loaded end.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const entriesMock = vi.fn<() => Promise<unknown>>()

vi.mock('@/client/api/reader', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/client/api/reader')>()
  return {
    ...mod,
    createMinifluxReaderApi: () =>
      ({
        entries: (...args: unknown[]) =>
          (entriesMock as (...a: unknown[]) => unknown)(...args),
      }) as unknown as ReturnType<typeof mod.createMinifluxReaderApi>,
  }
})

import { useReaderStore } from '@/client/stores/reader'
import type { MinifluxEntry } from '@/shared/types'

/** Entry published at epoch second `sec`. */
function mk(id: number, sec: number): MinifluxEntry {
  return {
    id,
    user_id: 1,
    feed_id: 7,
    title: `entry ${id}`,
    url: `https://example.com/${id}`,
    author: '',
    content: '',
    published_at: new Date(sec * 1000).toISOString(),
    status: 'unread',
    starred: false,
    reading_time: 1,
    feed: { id: 7, user_id: 1, title: 'F', site_url: '', feed_url: '', category: null },
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
  entriesMock.mockReset()
})

describe('loadMore', () => {
  it('appends fresh entries and adopts the server cursor/hasMore', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.nextCursor = 'c1'
    reader.hasMore = true
    entriesMock.mockResolvedValue({
      entries: [mk(2, 90)],
      nextCursor: 'c2',
      hasMore: false,
    })

    await reader.loadMore()

    expect(reader.entries.map((e) => e.id)).toEqual([1, 2])
    expect(reader.nextCursor).toBe('c2')
    expect(reader.hasMore).toBe(false)
  })

  it('keeps paging when a page is entirely duplicates (bulk-second window)', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.nextCursor = 'c1'
    reader.hasMore = true
    // Everything overlaps → zero fresh ids; the old code bailed to hasMore=false.
    entriesMock.mockResolvedValue({
      entries: [mk(1, 100)],
      nextCursor: 'c2',
      hasMore: true,
    })

    await reader.loadMore()

    expect(reader.entries.map((e) => e.id)).toEqual([1]) // nothing appended…
    expect(reader.hasMore).toBe(true) // …but not stopped either
    expect(reader.nextCursor).toBe('c2')

    // And the next round proceeds from the advanced cursor.
    entriesMock.mockResolvedValue({
      entries: [mk(2, 90)],
      nextCursor: 'c3',
      hasMore: false,
    })
    await reader.loadMore()
    expect(entriesMock).toHaveBeenLastCalledWith(expect.anything(), 'c2')
    expect(reader.entries.map((e) => e.id)).toEqual([1, 2])
  })

  it('is inert while already loading or when hasMore is false', async () => {
    const reader = useReaderStore()
    reader.hasMore = false
    await reader.loadMore()
    expect(entriesMock).not.toHaveBeenCalled()
  })
})

describe('checkTail', () => {
  it('appends items that arrived past the tail and re-arms hasMore', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.nextCursor = null
    reader.hasMore = false
    entriesMock.mockResolvedValue({
      entries: [mk(9, 120)],
      nextCursor: 'x~5',
      hasMore: true,
    })

    await reader.checkTail()

    expect(entriesMock).toHaveBeenCalledTimes(1)
    // Tail cursor: anchored at the last entry's timestamp, skipping itself.
    expect(entriesMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'unread' }),
      `${mk(1, 100).published_at}~1`,
    )
    expect(reader.entries.map((e) => e.id)).toEqual([1, 9])
    expect(reader.hasMore).toBe(true)
    expect(reader.nextCursor).toBe('x~5')
  })

  it('does nothing when the server returns nothing new', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.hasMore = false
    entriesMock.mockResolvedValue({ entries: [], nextCursor: null, hasMore: false })

    await reader.checkTail()

    expect(reader.entries.map((e) => e.id)).toEqual([1])
    expect(reader.hasMore).toBe(false)
  })

  it('skips search views (two-phase cursor cannot be rebuilt)', async () => {
    const reader = useReaderStore()
    reader.filter = { status: 'unread', search: 'hello' }
    reader.entries = [mk(1, 100)]
    await reader.checkTail()
    expect(entriesMock).not.toHaveBeenCalled()
  })

  it('skips newest sort (fresh items surface at the top, not the tail)', async () => {
    const reader = useReaderStore()
    reader.sort = 'newest'
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.hasMore = false
    await reader.checkTail()
    expect(entriesMock).not.toHaveBeenCalled()
  })
})

describe('loadEnd', () => {
  it('paginates while hasMore remains', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.nextCursor = 'c1'
    reader.hasMore = true
    entriesMock.mockResolvedValue({
      entries: [mk(2, 90)],
      nextCursor: 'c2',
      hasMore: false,
    })

    await reader.loadEnd()

    expect(entriesMock).toHaveBeenLastCalledWith(expect.anything(), 'c1')
    expect(reader.entries.map((e) => e.id)).toEqual([1, 2])
  })

  it('rechecks the tail once paginated out, resuming pagination on fresh items', async () => {
    const reader = useReaderStore()
    reader.entries = [mk(1, 100)]
    reader.seenIds = new Set([1])
    reader.nextCursor = null
    reader.hasMore = false
    entriesMock
      .mockResolvedValueOnce({ entries: [mk(9, 120)], nextCursor: 'x~5', hasMore: true })
      .mockResolvedValueOnce({ entries: [mk(10, 140)], nextCursor: null, hasMore: false })

    await reader.loadEnd()

    // Tail check first, anchored at the loaded tail…
    expect(entriesMock).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      `${mk(1, 100).published_at}~1`,
    )
    // …then the resumed page pull from the adopted cursor.
    expect(entriesMock).toHaveBeenNthCalledWith(2, expect.anything(), 'x~5')
    expect(reader.entries.map((e) => e.id)).toEqual([1, 9, 10])
    expect(reader.hasMore).toBe(false)
  })
})
