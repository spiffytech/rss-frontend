import { AsyncLocalStorage } from 'node:async_hooks'
import { loadConfig } from './config'
import type {
  EntriesPage,
  FeedCounters,
  MinifluxCategoryCount,
  MinifluxEntry,
  MinifluxFeed,
} from '../../shared/types'
import type { EntriesFilter } from '../../shared/filter'

const config = loadConfig()

/**
 * Per-request Miniflux credential. Middleware wraps each request (including
 * its async SSE streams) in `run({token})`; `request()` reads the token from
 * the current context. Falls back to the bootstrap env token when no session
 * is active (admin/deploy path). AsyncLocalStorage keeps concurrent requests
 * from leaking credentials into each other.
 */
export const minifluxContext = new AsyncLocalStorage<{ token: string }>()

class MinifluxError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

/** Generic Miniflux request using the request-scoped session credential. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = minifluxContext.getStore()?.token
  if (!token) {
    throw new Error(
      'No Miniflux credential: this request has no session API key. All Miniflux calls must run inside minifluxContext.run({ token }, …).',
    )
  }
  const url = `${config.minifluxUrl}/v1${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
      ...(init?.headers),
    },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error_message?: string }
      if (body.error_message) detail = body.error_message
    } catch {
      // ignore
    }
    throw new MinifluxError(`Miniflux ${res.status}: ${detail}`, res.status)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function getFeeds(): Promise<MinifluxFeed[]> {
  return request('/feeds')
}

export function getCategories(includeCounts = true): Promise<MinifluxCategoryCount[]> {
  return request(`/categories${includeCounts ? '?counts=true' : ''}`)
}

const PAGE_SIZE = 20

/**
 * Cursor-paginated entry fetch. Fetches PAGE_SIZE + 1 entries to determine
 * hasMore without an extra round-trip; slices to PAGE_SIZE before returning.
 *
 * Cursor is `published_before`/`published_after` (unix seconds) on the last
 * entry of the previous page. Miniflux's filters are strict (exclude the
 * boundary), so we apply +1/-1 second adjustment to include the pivot entry's
 * neighbors. Without a cursor, fetches the first page.
 *
 * For show-read-items mode, repeated `status` params (unread+read) are sent
 * in a single request so the server returns both in published_at order,
 * avoiding a merge-sort across two fetches.
 */
export async function getEntriesPage(
  filter: EntriesFilter,
  cursor?: string,
): Promise<EntriesPage> {
  const oldestFirst = filter.sort !== 'newest'
  const direction = oldestFirst ? 'asc' : 'desc'
  const params = new URLSearchParams()
  params.set('order', 'published_at')
  params.set('direction', direction)
  // Fetch one extra to detect hasMore without a separate count query.
  params.set('limit', String(PAGE_SIZE + 1))
  if (filter.starred) params.set('starred', 'true')
  if (filter.search) params.set('search', filter.search)
  // Repeated status param: unread + read when not hiding read items.
  // Miniflux ≥2.0.24 supports repeated status filters in one request.
  params.append('status', 'unread')
  if (!filter.hideReadItems) params.append('status', 'read')

  // Cursor: inclusive boundary so bulk same-second publishes aren't dropped.
  // Miniflux's published_before/after are strict (> ts / < ts) and exclude the
  // boundary second entirely. Rounded-down cursor would skip/dup entries that
  // share the pivot's second (scraped feeds, repost bots publish in bulk). Fix:
  // oldest-first sends published_after = floor(pivot_s) - 1; newest-first sends
  // published_before = floor(pivot_s) + 1 — re-including the pivot's whole
  // second. The client dedupes the resulting overlap by entry id (see
  // reader.ts loadMore).
  if (cursor) {
    const ts = Math.floor(new Date(cursor).getTime() / 1000)
    if (oldestFirst) {
      params.set('published_after', String(ts - 1))
    } else {
      params.set('published_before', String(ts + 1))
    }
  }

  // Feed-specific queries must go through /v1/feeds/:id/entries.
  const path = filter.feedId
    ? `/feeds/${filter.feedId}/entries?${params.toString()}`
    : `/entries?${params.toString()}`
  const data = await request<{ entries: MinifluxEntry[]; total: number }>(path)

  const hasMore = data.entries.length > PAGE_SIZE
  const entries = hasMore ? data.entries.slice(0, PAGE_SIZE) : data.entries

  // Sort client-side as a safety net — Miniflux's direction is not always
  // a strict total order across page boundaries.
  entries.sort((a, b) => {
    const diff = new Date(a.published_at).getTime() - new Date(b.published_at).getTime()
    return oldestFirst ? diff : -diff
  })

  const last = entries.length > 0 ? entries[entries.length - 1] : undefined
  const nextCursor = hasMore && last ? last.published_at : undefined

  return { entries, nextCursor, hasMore }
}

/**
 * Server-side post-processing of entry HTML: adds `loading="lazy"` to all
 * iframe and img elements so off-screen embeds don't render until scrolled
 * into view. This keeps the scrollbar honest (content is in the DOM) while
 * preventing 100 YouTube iframes from wrecking the browser on initial load.
 */
export function lazyHtml(html: string): string {
  // Only add loading="lazy" if not already present.
  return html
    .replace(/<(iframe|img)(\s)(?![^>]*loading=)/gi, '<$1$2loading="lazy" ')
}

export function getCounters(): Promise<FeedCounters> {
  return request('/feeds/counters')
}

/** Fetch a feed's icon (mime type + base64 data) for the sidebar. */
export function getFeedIcon(feedId: number): Promise<{
  mime_type: string
  data: string
}> {
  return request(`/feeds/${feedId}/icon`)
}

export async function markEntries(entryIds: number[], status: 'read' | 'unread'): Promise<void> {
  await request('/entries', {
    method: 'PUT',
    body: JSON.stringify({ entry_ids: entryIds, status }),
  })
}

/** Mark a whole feed read (native Miniflux endpoint; 204 per docs ≥2.0.26). */
export function markFeedAllRead(feedId: number): Promise<void> {
  return request(`/feeds/${feedId}/mark-all-as-read`, { method: 'PUT' })
}

/** Mark a whole category read (native Miniflux endpoint). */
export function markCategoryAllRead(categoryId: number): Promise<void> {
  return request(`/categories/${categoryId}/mark-all-as-read`, { method: 'PUT' })
}

/** Mark the whole user's entries read (native Miniflux endpoint). */
export function markUserAllRead(userId: number): Promise<void> {
  return request(`/users/${userId}/mark-all-as-read`, { method: 'PUT' })
}

/**
 * Fetch entry ids matching a simple filter (status/starred only — Miniflux's
 * /entries/ids ignores search). Used for the starred mark-all path.
 */
export async function getEntryIds(opts: {
  status?: 'read' | 'unread'
  starred?: boolean
}): Promise<number[]> {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.starred != null) params.set('starred', String(opts.starred))
  const data = await request<{ total: number; entry_ids: number[] }>(`/entries/ids?${params.toString()}`)
  return data.entry_ids ?? []
}

/**
 * Mark all unread entries matching a search string read. /entries/ids ignores
 * search and there's no native mark-all-for-a-search endpoint, so iterate
 * pages of unread results server-side and mark each page in batches. Bounded
 * by the page loop (each GET is PAGE_SIZE rows); no id list is shipped from
 * the client.
 */
export async function markSearchAllRead(search: string): Promise<void> {
  let cursor: string | undefined
  const BATCH = 100
  let batch: number[] = []
  const flush = async () => {
    if (batch.length > 0) {
      await markEntries(batch, 'read')
      batch = []
    }
  }
  for (;;) {
    const page = await getEntriesPage({ status: 'unread', search, hideReadItems: true, sort: 'oldest' }, cursor)
    for (const e of page.entries) batch.push(e.id)
    if (batch.length >= BATCH) await flush()
    if (!page.hasMore || !page.nextCursor) break
    cursor = page.nextCursor
  }
  await flush()
}

export async function toggleBookmark(entryId: number): Promise<void> {
  await request(`/entries/${entryId}/bookmark`, { method: 'PUT' })
}

export async function refreshFeeds(): Promise<void> {
  await request('/feeds/refresh', { method: 'PUT' })
}

/** Fetch a single entry fresh (used to re-render a patched row). */
export function getEntry(entryId: number): Promise<MinifluxEntry> {
  return request(`/entries/${entryId}`)
}

/** Authenticate a user's Miniflux username/password (HTTP Basic).
 *  /v1/me is the only endpoint accepting Basic auth, so we capture the
 *  authenticated user's `id` here — NOT from a call made with a token, which
 *  would resolve to the token owner (the bootstrap admin) instead of the user
 *  who actually logged in. This id keys the per-account preference store. */
export async function authenticateWithPassword(
  username: string,
  password: string,
): Promise<{ id: number; username: string }> {
  const url = `${config.minifluxUrl}/v1/me`
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error_message?: string }
      if (body.error_message) detail = body.error_message
    } catch {
      // ignore
    }
    throw new MinifluxError(`Miniflux ${res.status}: ${detail}`, res.status)
  }
  return (await res.json()) as { id: number; username: string }
}

/**
 * Create an API key scoped to a specific user, authenticated with that user's
 * own username/password (HTTP Basic). Miniflux POST /v1/api-keys creates the
 * key for the authenticated principal, so a token-scoped call would mint the
 * key for the *token owner* (the bootstrap admin). Using Basic credentials
 * makes the session key belong to the user who actually logged in, so every
 * subsequent call operates as that account — not as admin.
 */
export async function createApiKeyAs(
  username: string,
  password: string,
  description: string,
): Promise<{ id: number; token: string }> {
  const url = `${config.minifluxUrl}/v1/api-keys`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error_message?: string }
      if (body.error_message) detail = body.error_message
    } catch {
      // ignore
    }
    throw new MinifluxError(`Miniflux ${res.status}: ${detail}`, res.status)
  }
  return (await res.json()) as { id: number; token: string }
}

/** Delete a feed (unsubscribe). */
export async function deleteFeed(feedId: number): Promise<void> {
  await request(`/feeds/${feedId}`, { method: 'DELETE' })
}

/** Rename a category (folder). */
export async function updateCategory(categoryId: number, title: string): Promise<void> {
  await request(`/categories/${categoryId}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  })
}

/** Rename a feed. */
export async function updateFeed(feedId: number, title: string): Promise<void> {
  await request(`/feeds/${feedId}`, {
    method: 'PUT',
    body: JSON.stringify({ title }),
  })
}

/** Delete a Miniflux API key (logout). */
export async function deleteApiKey(keyId: number): Promise<void> {
  await request(`/api-keys/${keyId}`, { method: 'DELETE' })
}

export { MinifluxError }
