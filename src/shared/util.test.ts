import { describe, expect, test } from 'bun:test'

import { computeUnreadCount, timeAgo, lazyHtml } from './util'

describe('computeUnreadCount', () => {
  const feeds = [
    { id: 1, category: { id: 10 } },
    { id: 2, category: { id: 10 } },
    { id: 3, category: { id: 11 } },
  ]
  const unreads: Record<string, number> = { 1: 5, 2: 0, 3: 7 }

  test('feed unread count', () => {
    expect(computeUnreadCount({ feedId: 1 }, feeds, unreads)).toBe(5)
  })

  test('missing feed count is 0', () => {
    expect(computeUnreadCount({ feedId: 99 }, feeds, unreads)).toBe(0)
  })

  test('starred has no meaningful count', () => {
    expect(computeUnreadCount({ starred: true }, feeds, unreads)).toBeNull()
  })

  test('category sums its feeds', () => {
    expect(computeUnreadCount({ categoryId: 10 }, feeds, unreads)).toBe(5)
  })

  test('Latest sums everything', () => {
    expect(computeUnreadCount({}, feeds, unreads)).toBe(12)
  })
})

describe('timeAgo', () => {
  test('under a minute', () => {
    expect(timeAgo(new Date(Date.now() - 30_000).toISOString())).toBe('now')
  })

  test('minutes', () => {
    expect(timeAgo(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m')
  })

  test('hours', () => {
    expect(timeAgo(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h')
  })

  test('days', () => {
    expect(timeAgo(new Date(Date.now() - 12 * 86_400_000).toISOString())).toBe('12d')
  })

  test('invalid input renders empty', () => {
    expect(timeAgo('not-a-date')).toBe('')
  })
})

describe('lazyHtml', () => {
  test('adds loading=lazy to img without it', () => {
    expect(lazyHtml('<img src="x">')).toBe('<img loading="lazy" src="x">')
  })

  test('adds loading=lazy to iframe without it', () => {
    expect(lazyHtml('<iframe src="x"></iframe>')).toBe('<iframe loading="lazy" src="x"></iframe>')
  })

  test('leaves existing loading attribute alone', () => {
    expect(lazyHtml('<img loading="eager" src="x">')).toBe('<img loading="eager" src="x">')
  })

  test('adds an aspect-ratio to iframe with width and height', () => {
    expect(lazyHtml('<iframe width="560" height="315" src="x"></iframe>')).toBe(
      '<iframe style="aspect-ratio:560 / 315;" loading="lazy" width="560" height="315" src="x"></iframe>',
    )
  })

  test('merges aspect-ratio into an existing style attribute', () => {
    expect(lazyHtml('<iframe style="border:0" width="560" height="315" src="x"></iframe>')).toBe(
      '<iframe loading="lazy" style="aspect-ratio:560 / 315;border:0" width="560" height="315" src="x"></iframe>',
    )
  })

  test('skips percentage widths (no ratio to derive)', () => {
    expect(lazyHtml('<iframe width="100%" height="315" src="x"></iframe>')).toBe(
      '<iframe loading="lazy" width="100%" height="315" src="x"></iframe>',
    )
  })

  test('leaves an iframe without dimensions alone', () => {
    expect(lazyHtml('<iframe src="x"></iframe>')).toBe('<iframe loading="lazy" src="x"></iframe>')
  })
})
