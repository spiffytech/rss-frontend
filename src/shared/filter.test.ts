import { describe, expect, test } from 'bun:test'

import { parseFilterFromUrl, zodEntriesFilter } from './filter'

describe('parseFilterFromUrl', () => {
  test('parses defaults (Latest)', () => {
    expect(parseFilterFromUrl({})).toEqual({ status: 'unread' })
  })

  test('parses feed id', () => {
    expect(parseFilterFromUrl({ feed: '155' })).toEqual({ status: 'unread', feedId: 155 })
  })

  test('parses category id', () => {
    expect(parseFilterFromUrl({ category: '3' })).toEqual({ status: 'unread', categoryId: 3 })
  })

  test('parses starred', () => {
    expect(parseFilterFromUrl({ starred: '1' })).toEqual({ status: 'unread', starred: true })
  })

  test('parses search', () => {
    expect(parseFilterFromUrl({ search: 'vue' })).toEqual({ status: 'unread', search: 'vue' })
  })

  test('ignores invalid numeric values', () => {
    expect(parseFilterFromUrl({ feed: 'abc', category: '-1' })).toEqual({ status: 'unread' })
  })

  test('treats non-1 starred as off', () => {
    expect(parseFilterFromUrl({ starred: 'true' })).toEqual({ status: 'unread' })
  })
})

describe('zodEntriesFilter', () => {
  test('defaults status to unread', () => {
    expect(zodEntriesFilter.parse({})).toMatchObject({ status: 'unread' })
  })

  test('accepts empty-string feedId (client sends it)', () => {
    expect(zodEntriesFilter.parse({ feedId: '' }).feedId).toBe('')
  })

  test('strips unknown keys (default non-strict mode)', () => {
    expect(zodEntriesFilter.parse({ bogus: 1 })).toEqual({ status: 'unread' })
  })
})
