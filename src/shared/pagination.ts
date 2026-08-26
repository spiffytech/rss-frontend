// Pagination cursor codec shared by the server provider layer. A cursor pins
// the query window to a published_at second (the "anchor") plus how many
// already-served results to skip within that window (`skip`), so pages make
// guaranteed progress even when dozens of entries share one publish second —
// a plain timestamp cursor would re-fetch the same block forever and force the
// client to stop early.
//
// Wire format (opaque to the client; '~' can't appear in ISO timestamps):
//   reading: "<isoTs>"              (skip 0)
//            "<isoTs>~<skip>"
//   search:  "unread~<isoTs>~<skip>" | "unread~<isoTs>"
//            "read~<isoTs>~<skip>"  | "read~"   ("read~" = start of read bucket)

export interface PageCursor {
  /** Window anchor: entries are fetched relative to this instant's second. */
  anchorTs?: string
  /** Already-served results to skip inside the anchored window. */
  skip: number
}

export function encodeCursor(cursor: PageCursor): string | undefined {
  if (!cursor.anchorTs) return undefined
  return cursor.skip > 0 ? `${cursor.anchorTs}~${cursor.skip}` : cursor.anchorTs
}

export function decodeCursor(cursor?: string): PageCursor {
  if (!cursor) return { skip: 0 }
  const sep = cursor.indexOf('~')
  if (sep === -1) return { anchorTs: cursor || undefined, skip: 0 }
  const anchorTs = cursor.slice(0, sep) || undefined
  const skip = Number.parseInt(cursor.slice(sep + 1), 10)
  return { anchorTs, skip: Number.isFinite(skip) && skip > 0 ? skip : 0 }
}

export type SearchBucket = 'unread' | 'read'

/** Decode a search cursor: "<bucket>~[<isoTs>[~<skip>]]" or a bare reading cursor. */
export function decodeSearchCursor(cursor?: string): {
  bucket: SearchBucket
  anchor: PageCursor
} {
  if (!cursor) return { bucket: 'unread', anchor: { skip: 0 } }
  const sep = cursor.indexOf('~')
  const prefix = sep === -1 ? '' : cursor.slice(0, sep)
  if (prefix === 'unread' || prefix === 'read') {
    const rest = cursor.slice(sep + 1)
    // "read" alone marks the hand-off to the read bucket's first page.
    return { bucket: prefix, anchor: rest ? decodeCursor(rest) : { skip: 0 } }
  }
  return { bucket: 'unread', anchor: decodeCursor(cursor) }
}

export function encodeSearchCursor(bucket: SearchBucket, anchor: PageCursor): string {
  const inner = encodeCursor(anchor)
  return inner ? `${bucket}~${inner}` : bucket
}
