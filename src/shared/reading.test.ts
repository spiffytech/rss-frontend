import { describe, expect, test } from 'bun:test'

import { pickTopmostVisible, shouldAutoRead, clampNavIndex } from './reading'

describe('pickTopmostVisible', () => {
  test('picks the topmost visible entry', () => {
    const registry = new Map([
      [1, { top: 100, bottom: 400 }],
      [2, { top: 500, bottom: 900 }],
      [3, { top: -50, bottom: 80 }], // partially scrolled out, still visible
    ])
    expect(pickTopmostVisible(registry)).toBe(3)
  })

  test('skips entries fully scrolled above', () => {
    const registry = new Map([
      [1, { top: -100, bottom: -20 }],
      [2, { top: 200, bottom: 300 }],
    ])
    expect(pickTopmostVisible(registry)).toBe(2)
  })

  test('returns null when nothing is visible', () => {
    const registry = new Map([[1, { top: -100, bottom: -50 }]])
    expect(pickTopmostVisible(registry)).toBeNull()
  })

  test('returns null for an empty registry', () => {
    expect(pickTopmostVisible(new Map())).toBeNull()
  })
})

describe('shouldAutoRead', () => {
  const base = {
    viewMode: 'expanded' as const,
    userHasScrolled: true,
    disabledAutoReadFeeds: [9] as number[],
    keepUnreadIds: [77] as number[],
    feedId: 1,
    entryId: 5,
    status: 'unread' as const,
  }

  test('autotreads an unread entry with no blockers', () => {
    expect(shouldAutoRead(base)).toBe(true)
  })

  test('blocks in list view', () => {
    expect(shouldAutoRead({ ...base, viewMode: 'list' })).toBe(false)
  })

  test('blocks before the user has scrolled', () => {
    expect(shouldAutoRead({ ...base, userHasScrolled: false })).toBe(false)
  })

  test('blocks when the feed has auto-read disabled', () => {
    expect(shouldAutoRead({ ...base, feedId: 9 })).toBe(false)
  })

  test('blocks explicitly kept-unread entries', () => {
    expect(shouldAutoRead({ ...base, entryId: 77 })).toBe(false)
  })

  test('blocks read entries', () => {
    expect(shouldAutoRead({ ...base, status: 'read' })).toBe(false)
  })
})

describe('clampNavIndex', () => {
  test('clamps low', () => {
    expect(clampNavIndex(-3, 10)).toBe(0)
  })

  test('clamps high', () => {
    expect(clampNavIndex(99, 10)).toBe(9)
  })

  test('passes through in-range values', () => {
    expect(clampNavIndex(4, 10)).toBe(4)
  })

  test('empty list returns 0', () => {
    expect(clampNavIndex(2, 0)).toBe(0)
  })
})
