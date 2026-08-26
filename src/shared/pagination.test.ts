import { describe, expect, test } from 'bun:test'

import {
  decodeCursor,
  decodeSearchCursor,
  encodeCursor,
  encodeSearchCursor,
} from './pagination'

describe('encodeCursor/decodeCursor', () => {
  test('first-page cursor (no anchor) encodes to undefined', () => {
    expect(encodeCursor({ skip: 0 })).toBeUndefined()
  })

  test('anchor without skip encodes as a bare timestamp', () => {
    expect(encodeCursor({ anchorTs: '2024-01-01T00:00:05Z', skip: 0 })).toBe(
      '2024-01-01T00:00:05Z',
    )
  })

  test('anchor with skip encodes with ~ separator', () => {
    expect(encodeCursor({ anchorTs: '2024-01-01T00:00:05Z', skip: 21 })).toBe(
      '2024-01-01T00:00:05Z~21',
    )
  })

  test('decoding round-trips', () => {
    expect(decodeCursor('2024-01-01T00:00:05Z')).toEqual({
      anchorTs: '2024-01-01T00:00:05Z',
      skip: 0,
    })
    expect(decodeCursor('2024-01-01T00:00:05Z~21')).toEqual({
      anchorTs: '2024-01-01T00:00:05Z',
      skip: 21,
    })
  })

  test('ISO colons survive decoding (only ~ splits)', () => {
    const cur = decodeCursor('2024-01-01T10:20:30Z~7')
    expect(cur.anchorTs).toBe('2024-01-01T10:20:30Z')
    expect(cur.skip).toBe(7)
  })

  test('empty/garbage input is tolerated', () => {
    expect(decodeCursor(undefined)).toEqual({ skip: 0 })
    expect(decodeCursor('')).toEqual({ skip: 0 })
    // Bare '~' = anchor dropped, invalid skip clamped to 0.
    expect(decodeCursor('~')).toEqual({ anchorTs: undefined, skip: 0 })
    expect(decodeCursor('ts~bogus')).toEqual({ anchorTs: 'ts', skip: 0 })
  })
})

describe('decodeSearchCursor/encodeSearchCursor', () => {
  test('no cursor → unread bucket, first page', () => {
    expect(decodeSearchCursor(undefined)).toEqual({
      bucket: 'unread',
      anchor: { skip: 0 },
    })
  })

  test('bare timestamp → unread bucket (legacy first-phase cursor)', () => {
    expect(decodeSearchCursor('2024-01-01T00:00:00Z')).toEqual({
      bucket: 'unread',
      anchor: { anchorTs: '2024-01-01T00:00:00Z', skip: 0 },
    })
  })

  test('bucket-prefixed cursors decode bucket + anchor', () => {
    expect(decodeSearchCursor('unread~2024-01-01T00:00:00Z')).toEqual({
      bucket: 'unread',
      anchor: { anchorTs: '2024-01-01T00:00:00Z', skip: 0 },
    })
    expect(decodeSearchCursor('read~2024-01-01T00:00:00Z~14')).toEqual({
      bucket: 'read',
      anchor: { anchorTs: '2024-01-01T00:00:00Z', skip: 14 },
    })
  })

  test('"read~" marks the read-bucket handoff (no anchor yet)', () => {
    expect(decodeSearchCursor('read~')).toEqual({
      bucket: 'read',
      anchor: { skip: 0 },
    })
  })

  test('search encode/decode round-trips', () => {
    const wire = encodeSearchCursor('read', { anchorTs: '2024-06-01T12:00:00Z', skip: 3 })
    expect(wire).toBe('read~2024-06-01T12:00:00Z~3')
    expect(decodeSearchCursor(wire)).toEqual({
      bucket: 'read',
      anchor: { anchorTs: '2024-06-01T12:00:00Z', skip: 3 },
    })
  })

  test('hand-off cursor encodes as bare bucket name', () => {
    expect(encodeSearchCursor('unread', { skip: 0 })).toBe('unread')
  })
})
