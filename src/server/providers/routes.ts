// Provider route factory — builds the Hono sub-app for a Provider. Routes are
// written only against the Provider interface + shared types, so a future
// provider mounts at /api/<name> with the same factory. All responses are
// plain JSON (no datastar signal/SSE ceremony).
//
// IMPORTANT: chained Hono expression only (no `const app + app.get`) so the
// route schema survives into the return type — that powers the RPC client.

import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

import { zodEntriesFilter } from '../../shared/filter'
import type { EntriesFilter } from '../../shared/filter'
import type {
  BootstrapResult,
  EntriesResult,
  FeedPanelResult,
  MarkAllReadResult,
  RefreshResult,
  RenameResult,
} from '../../shared/types'
import { getAllFeedPrefs, getUserPrefs, saveFeedPrefs, saveUserPrefs } from '../lib/prefs'
import type { Provider } from './types'

const zodViewMode = z.enum(['expanded', 'list'])
const zodSort = z.enum(['oldest', 'newest'])
const zodIdParam = z.object({ id: z.coerce.number().int().positive() })

// --- Shared helpers ---

/** Fresh sidebar data (feeds/categories/unread counters). */
async function feedPanel(provider: Provider): Promise<FeedPanelResult> {
  const [feeds, categories, counters] = await Promise.all([
    provider.getFeeds(),
    provider.getCategories(),
    provider.getCounters(),
  ])
  return { feeds, categories, counters: counters.unreads }
}

function entriesResult(page: {
  entries: import('../../shared/types').MinifluxEntry[]
  nextCursor?: string
  hasMore: boolean
}): EntriesResult {
  return {
    entries: page.entries,
    nextCursor: page.nextCursor ?? null,
    hasMore: page.hasMore,
  }
}

/** Resolve the full filter from the submitted partial (defaults for view prefs
 *  come from the per-feed prefs the client already shipped / holds). */
function resolvedFilter(q: Partial<EntriesFilter> | undefined): EntriesFilter {
  return { status: 'unread', sort: 'oldest', hideReadItems: true, ...q }
}

export function createProviderRoutes(
  provider: Provider,
  deps: {
    getUserId: () => number | undefined
    /** Session gate: rejects unauthenticated requests, sets request context. */
    gate: MiddlewareHandler
  },
) {
  return new Hono()
    // ---- Gate: everything after this requires a session ----
    .use('*', deps.gate)

    // ---- Bootstrap: everything the SPA needs once at page load ----
    .post(
      '/bootstrap',
      zValidator('json', z.object({ filter: zodEntriesFilter.partial().optional() })),
      async (c) => {
        const userId = deps.getUserId()
        const q = c.req.valid('json').filter
        const feedPrefs = userId != null ? getAllFeedPrefs(userId) : {}
        const userPrefs = userId != null ? getUserPrefs(userId) : {}
        const filter = resolvedFilter(q)
        // Per-feed view defaults override the hardcoded global defaults.
        const currentPrefs = filter.feedId != null ? feedPrefs[Number(filter.feedId)] : undefined
        if (currentPrefs) {
          filter.sort = currentPrefs.sort ?? 'oldest'
          filter.hideReadItems = currentPrefs.hideReadItems ?? true
        }
        const [page, panel] = await Promise.all([
          provider.getEntriesPage(filter),
          feedPanel(provider),
        ])
        const result: BootstrapResult = {
          ...entriesResult(page),
          ...panel,
          userPrefs,
          feedPrefs,
        }
        return c.json(result)
      },
    )

    // ---- Entries (pagination) ----
    .post(
      '/entries',
      zValidator('json', z.object({
        filter: zodEntriesFilter.partial().optional(),
        cursor: z.string().optional(),
      })),
      async (c) => {
        const body = c.req.valid('json')
        const filter = resolvedFilter(body.filter)
        const page = await provider.getEntriesPage(filter, body.cursor)
        return c.json(entriesResult(page))
      },
    )

    // ---- Counters (lean; refreshed on nav + after bulk ops) ----
    .get('/counters', async (c) => {
      const counters = await provider.getCounters()
      return c.json(counters.unreads)
    })

    // ---- Single-entry mutations ----

    // Batched status set (read/unread). The client is optimistic: it applies
    // the change locally immediately and fires this with the accumulated ids
    // on a short debounce, so one HTTP round-trip covers a whole scroll.
    // Returns 204; the client reconciles counters on nav/refresh.
    .post(
      '/entries/status',
      zValidator('json', z.object({
        entryIds: z.array(z.number().int().positive()),
        status: z.enum(['read', 'unread']),
      })),
      async (c) => {
        const { entryIds, status } = c.req.valid('json')
        if (entryIds.length > 0) await provider.markEntries(entryIds, status)
        return c.body(null, 204)
      },
    )

    .post(
      '/entries/:id/toggleRead',
      zValidator('param', zodIdParam),
      async (c) => {
        const { id } = c.req.valid('param')
        const entry = await provider.getEntry(id)
        const newStatus: 'read' | 'unread' = entry.status === 'read' ? 'unread' : 'read'
        await provider.markEntries([id], newStatus)
        const fresh = await provider.getEntry(id)
        return c.json({ entry: fresh })
      },
    )

    .post(
      '/entries/:id/star',
      zValidator('param', zodIdParam),
      async (c) => {
        const { id } = c.req.valid('param')
        await provider.toggleBookmark(id)
        const fresh = await provider.getEntry(id)
        return c.json({ entry: fresh })
      },
    )

    .post(
      '/entries/:id/autoRead',
      zValidator('param', zodIdParam),
      async (c) => {
        const { id } = c.req.valid('param')
        // Server reads the disabled-feeds pref from its own store (no client
        // policy shipped). Kept-unread is a client-side guard only.
        const userId = deps.getUserId()
        const disabled = userId != null ? (getUserPrefs(userId).disabledAutoReadFeeds ?? []) : []
        const entry = await provider.getEntry(id)
        const skip = disabled.includes(entry.feed_id)
        if (!skip && entry.status === 'unread') {
          await provider.markEntries([id], 'read')
        }
        const fresh = await provider.getEntry(id)
        return c.json({ entry: fresh })
      },
    )

    // ---- Bulk / refresh ----

    .post(
      '/markAllRead',
      zValidator('json', z.object({ filter: zodEntriesFilter.partial().optional() })),
      async (c) => {
        const q = c.req.valid('json').filter
        const userId = deps.getUserId()
        if (userId != null) {
          await provider.markAllReadByFilter(resolvedFilter(q), userId)
        }
        const filter = resolvedFilter(q)
        // One-call: fresh page 1 + counters, no client entryIds.
        const [page, counters] = await Promise.all([
          provider.getEntriesPage(filter),
          provider.getCounters(),
        ])
        const result: MarkAllReadResult = {
          ...entriesResult(page),
          counters: counters.unreads,
        }
        return c.json(result)
      },
    )

    .post(
      '/refresh',
      zValidator('json', z.object({ filter: zodEntriesFilter.partial().optional() })),
      async (c) => {
        const body = c.req.valid('json')
        await provider.refreshFeeds()
        await Bun.sleep(1500)
        const filter = resolvedFilter(body.filter)
        const [page, panel] = await Promise.all([
          provider.getEntriesPage(filter),
          feedPanel(provider),
        ])
        const result: RefreshResult = { ...entriesResult(page), ...panel }
        return c.json(result)
      },
    )

    // ---- Feeds / categories ----

    .post('/feeds/:id/unsubscribe', zValidator('param', zodIdParam), async (c) => {
      const { id } = c.req.valid('param')
      try {
        await provider.deleteFeed(id)
      } catch {
        // Feed already gone — treat as success.
      }
      return c.body(null, 204)
    })

    .put(
      '/feeds/:id/rename',
      zValidator('param', zodIdParam),
      zValidator('json', z.object({ title: z.string().trim().min(1) })),
      async (c) => {
        const { id } = c.req.valid('param')
        const { title } = c.req.valid('json')
        await provider.updateFeed(id, title)
        const [feeds, categories] = await Promise.all([
          provider.getFeeds(),
          provider.getCategories(),
        ])
        const result: RenameResult = { feeds, categories }
        return c.json(result)
      },
    )

    .put(
      '/categories/:id/rename',
      zValidator('param', zodIdParam),
      zValidator('json', z.object({ title: z.string().trim().min(1) })),
      async (c) => {
        const { id } = c.req.valid('param')
        const { title } = c.req.valid('json')
        await provider.updateCategory(id, title)
        const [feeds, categories] = await Promise.all([
          provider.getFeeds(),
          provider.getCategories(),
        ])
        const result: RenameResult = { feeds, categories }
        return c.json(result)
      },
    )

    .get('/feeds/:id/icon', zValidator('param', zodIdParam), async (c) => {
      const { id } = c.req.valid('param')
      let icon
      try {
        icon = await provider.getFeedIcon(id)
      } catch {
        c.header('Cache-Control', 'private, max-age=3600, stale-while-revalidate=3600')
        return c.text('icon unavailable', 404)
      }
      const [declaredMime, base64] = icon.data.split(';base64,', 2)
      if (!base64 || !declaredMime) {
        c.header('Cache-Control', 'private, max-age=3600, stale-while-revalidate=3600')
        return c.text('icon unavailable', 404)
      }
      const bytes = Buffer.from(base64, 'base64')
      c.header('Cache-Control', 'private, max-age=7200, stale-while-revalidate=604800')
      return c.body(bytes, 200, { 'Content-Type': declaredMime })
    })

    // ---- Preferences (204; client applies locally, no re-fetch) ----

    .put(
      '/prefs/viewMode',
      zValidator('json', z.object({
        feedId: z.coerce.number().int().positive().optional(),
        viewMode: zodViewMode,
      })),
      async (c) => {
        const { feedId, viewMode } = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null && feedId != null) saveFeedPrefs(userId, feedId, { viewMode })
        return c.body(null, 204)
      },
    )

    .put(
      '/prefs/sort',
      zValidator('json', z.object({
        feedId: z.coerce.number().int().positive().optional(),
        sort: zodSort,
      })),
      async (c) => {
        const { feedId, sort } = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null && feedId != null) saveFeedPrefs(userId, feedId, { sort })
        return c.body(null, 204)
      },
    )

    .put(
      '/prefs/hideReadItems',
      zValidator('json', z.object({
        feedId: z.coerce.number().int().positive().optional(),
        hideReadItems: z.coerce.boolean(),
      })),
      async (c) => {
        const { feedId, hideReadItems } = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null && feedId != null) saveFeedPrefs(userId, feedId, { hideReadItems })
        return c.body(null, 204)
      },
    )

    .put(
      '/prefs/hideEmptyFeeds',
      zValidator('json', z.object({ hideEmptyFeeds: z.coerce.boolean() })),
      async (c) => {
        const body = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null) saveUserPrefs(userId, { hideEmptyFeeds: body.hideEmptyFeeds })
        return c.body(null, 204)
      },
    )

    .put(
      '/prefs/collapsedCats',
      zValidator('json', z.object({ collapsedCats: z.record(z.string(), z.boolean()) })),
      async (c) => {
        const body = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null) saveUserPrefs(userId, { collapsedCats: body.collapsedCats })
        return c.body(null, 204)
      },
    )

    .put(
      '/prefs/autoRead',
      zValidator('json', z.object({ disabledAutoReadFeeds: z.array(z.number()) })),
      async (c) => {
        const body = c.req.valid('json')
        const userId = deps.getUserId()
        if (userId != null) saveUserPrefs(userId, { disabledAutoReadFeeds: body.disabledAutoReadFeeds })
        return c.body(null, 204)
      },
    )
}
