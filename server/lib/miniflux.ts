import { AsyncLocalStorage } from 'node:async_hooks'
import { loadConfig } from './config'
import type {
  EntriesFilter,
  EntriesPage,
  FeedCounters,
  MinifluxCategory,
  MinifluxCategoryCount,
  MinifluxEntry,
  MinifluxFeed,
} from './types'

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
      ...(init?.headers ?? {}),
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

  // Cursor: strictly older/newer than the last entry's published_at.
  // published_before/after are unix seconds and exclude the boundary
  // timestamp entirely (entries at the exact same second are omitted too,
  // which is acceptable for a feed reader — same-second entries have
  // undefined order in our client-side sort anyway).
  if (cursor) {
    const ts = Math.floor(new Date(cursor).getTime() / 1000)
    if (oldestFirst) {
      params.set('published_after', String(ts))
    } else {
      params.set('published_before', String(ts))
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
