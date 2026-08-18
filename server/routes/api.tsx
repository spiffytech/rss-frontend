import { ServerSentEventGenerator } from '@starfederation/datastar-sdk/web'
import { z } from 'zod'
import { Hono } from 'hono'
import { etag } from 'hono/etag'

import * as miniflux from '../lib/miniflux'
import { computeUnreadCount } from '../lib/util'
import { renderToString } from '../lib/jsx-utils'
import EntryList, { EntryListFragment } from '../components/EntryList'
import EntryItem from '../components/EntryItem'
import FeedPanel from '../components/FeedPanel'
import { zodEntriesFilter } from '../lib/types'
import type { EntriesFilter, MinifluxEntry } from '../lib/types'
import { readSession } from '../lib/auth'
import { saveUserPrefs, saveFeedPrefs } from '../lib/prefs'

const zodViewMode = z.enum(['expanded', 'list'])

/** Datastar's expression engine stringifies booleans assigned at a nested
 *  object path (e.g. `$collapsedCats[id] = !$collapsedCats[id]` lands as the
 *  string "true"/"false"). Every `@put` echoes the full signal body, so the
 *  pref endpoints receive `collapsedCats` as strings; coerce them to booleans
 *  so a malformed value can't 500 an otherwise-unrelated toggle. */
const coerceBool = (v: unknown): boolean => {
  if (typeof v === 'boolean') return v
  return v === 'true' || v === '1'
}

const zodSignals = z.object({
  filter: zodEntriesFilter.default({ status: 'unread' }),
  viewMode: zodViewMode.default('expanded'),
  keepUnreadIds: z.array(z.number()).optional(),
  entryIds: z.array(z.number()).optional(),
  hideReadItems: z.boolean().optional(),
  hideEmptyFeeds: z.boolean().optional(),
  disabledAutoReadFeeds: z.array(z.number()).optional(),
  collapsedCats: z
    .record(z.string(), z.union([z.boolean(), z.string()]).transform(coerceBool))
    .optional(),
  renameTitle: z.string().optional(),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean().optional(),
})

/** Parse datastar signals from a GET query param (`?datastar=...`). */
function parseGetSignals(ctx: { req: { query: () => Record<string, string | undefined> } }) {
  const raw = ctx.req.query()['datastar']
  if (!raw) {
    return zodSignals.parse({ filter: { status: 'unread' } })
  }
  return zodSignals.parse(JSON.parse(raw))
}

/** Parse datastar signals from a POST/PUT JSON body (all signals sent as JSON). */
async function parseBodySignals(ctx: { req: { json: () => Promise<unknown> } }) {
  const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>
  return zodSignals.partial().parse(body)
}

/**
 * Re-fetch the sidebar counts from Miniflux (the source of truth) and patch the
 * FeedPanel. Called after any mark-read so the counts stay honest — we never
 * decrement locally, we re-read.
 */
async function refreshFeedPanel(
  generator: ServerSentEventGenerator,
  filter?: { feedId?: number | string; categoryId?: number | string; starred?: boolean; sort?: 'oldest' | 'newest' },
): Promise<void> {
  const [feeds, categories, counters] = await Promise.all([
    miniflux.getFeeds(),
    miniflux.getCategories(),
    miniflux.getCounters(),
  ])
  generator.patchElements(
    await renderToString(
      <FeedPanel
        categories={categories}
        feeds={feeds}
        counters={counters.unreads}
      />,
    ),
    { selector: '[data-testid="feed-panel"]', mode: 'outer' },
  )
  // Keep the toolbar unread count honest (re-read, never local math).
  if (filter) {
    generator.patchSignals(
      JSON.stringify({ unreadCount: computeUnreadCount(filter, feeds, counters.unreads) }),
    )
  }
}

/**
 * Re-fetch page 1 under the current filter and re-render the entry list.
 * Used by the view/sort/hide-read-items toggles — a view change is a full
 * list replacement (fresh pagination), exactly like mark-all-read.
 */
async function reRenderEntries(
  body: {
    filter?: EntriesFilter
    viewMode?: 'expanded' | 'list'
    hideReadItems?: boolean
  },
) {
  const filter: EntriesFilter = { ...(body.filter ?? { status: 'unread' }) }
  filter.hideReadItems = body.hideReadItems ?? true
  const page = await miniflux.getEntriesPage(filter)
  return ServerSentEventGenerator.stream(async (generator) => {
    generator.patchElements(
      await renderToString(<EntryList entries={page.entries} viewMode={body.viewMode ?? 'expanded'} />),
      { selector: '[data-testid="entry-list"]', mode: 'inner' },
    )
    generator.patchSignals(JSON.stringify({
      nextCursor: page.nextCursor ?? null,
      hasMore: page.hasMore,
      entryIds: page.entries.map((e) => e.id),
      currentId: page.entries[0]?.id ?? 0,
    }))
  })
}

export const apiRoutes = new Hono()
  .get('/api/entries', async (ctx) => {
    const signals = parseGetSignals(ctx)
    signals.filter = { ...signals.filter, hideReadItems: signals.hideReadItems ?? true }
    const page = await miniflux.getEntriesPage(signals.filter)
    return ServerSentEventGenerator.stream(async (generator) => {
      generator.patchElements(
        await renderToString(<EntryList entries={page.entries} viewMode={signals.viewMode} />),
        { selector: '[data-testid="entry-list"]', mode: 'inner' },
      )
      generator.patchSignals(JSON.stringify({
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        entryIds: page.entries.map((e) => e.id),
        currentId: page.entries[0]?.id ?? 0,
      }))
    })
  })
  .get('/api/entries/more', async (ctx) => {
    const signals = parseGetSignals(ctx)
    signals.filter = { ...signals.filter, hideReadItems: signals.hideReadItems ?? true }
    const cursor = signals.nextCursor ?? undefined
    const page = await miniflux.getEntriesPage(signals.filter, cursor)
    return ServerSentEventGenerator.stream(async (generator) => {
      // Remove old sentinel, append new entries (which include a fresh sentinel).

      const fragment = await renderToString(<EntryListFragment entries={page.entries} viewMode={signals.viewMode} />)
      generator.patchElements(fragment, { selector: '[data-testid="entry-list"]', mode: 'append' })
      generator.patchSignals(JSON.stringify({
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        loadingMore: false,
        entryIds: [...(signals.entryIds ?? []), ...page.entries.map((e) => e.id)],
      }))
    })
  })
  .post('/api/entries/:id/toggle-read', async (ctx) => {
    const id = Number(ctx.req.param('id'))
    const body = await parseBodySignals(ctx)
    return ServerSentEventGenerator.stream(async (generator) => {
      const entry = await miniflux.getEntry(id)
      const newStatus: 'read' | 'unread' = entry.status === 'read' ? 'unread' : 'read'
      await miniflux.markEntries([id], newStatus)
      const keepUnreadIds = body.keepUnreadIds ?? []
      // Keep-unread tracks what the user explicitly toggled to unread. Toggling
      // to unread marks it kept; toggling to read clears the keep flag.
      const keepIdx = keepUnreadIds.indexOf(id)
      if (newStatus === 'unread' && keepIdx === -1) keepUnreadIds.push(id)
      else if (newStatus === 'read' && keepIdx !== -1) keepUnreadIds.splice(keepIdx, 1)
      generator.patchSignals(JSON.stringify({ keepUnreadIds }))
      const fresh: MinifluxEntry = { ...entry, status: newStatus }
      generator.patchElements(
        await renderToString(
          <EntryItem entry={fresh} viewMode={body.viewMode ?? 'expanded'} />,
        ),
        { selector: `#entry-${id}`, mode: 'outer' },
      )
      await refreshFeedPanel(generator, body.filter)
    })
  })
  .post('/api/entries/:id/star', async (ctx) => {
    const id = Number(ctx.req.param('id'))
    const body = await parseBodySignals(ctx)
    return ServerSentEventGenerator.stream(async (generator) => {
      await miniflux.toggleBookmark(id)
      const fresh = await miniflux.getEntry(id)
      generator.patchElements(
        await renderToString(
          <EntryItem entry={fresh} viewMode={body.viewMode ?? 'expanded'} />,
        ),
        { selector: `#entry-${id}`, mode: 'outer' },
      )
    })
  })
  .post('/api/entries/:id/auto-read', async (ctx) => {
    const id = Number(ctx.req.param('id'))
    const body = await parseBodySignals(ctx)
    return ServerSentEventGenerator.stream(async (generator) => {
      await miniflux.markEntries([id], 'read')
      const fresh = await miniflux.getEntry(id)
      const keepUnreadIds = (body.keepUnreadIds ?? []).filter((k: number) => k !== id)
      generator.patchSignals(JSON.stringify({ keepUnreadIds }))
      generator.patchElements(
        await renderToString(
          <EntryItem entry={fresh} viewMode={body.viewMode ?? 'expanded'} />,
        ),
        { selector: `#entry-${id}`, mode: 'outer' },
      )
      await refreshFeedPanel(generator, body.filter)
    })
  })
  .put('/api/mark-all-read', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const filter: EntriesFilter = { ...(body.filter ?? { status: 'unread' }) }
    filter.hideReadItems = body.hideReadItems ?? true
    const entryIds = (body.entryIds ?? []).filter((x): x is number => typeof x === 'number')
    return ServerSentEventGenerator.stream(async (generator) => {
      if (entryIds.length > 0) {
        await miniflux.markEntries(entryIds, 'read')
      }
      // Stay on the current filter — do NOT advance to the next feed.
      // Re-fetch page 1 (no cursor) so read entries disappear (hideReadItems)
      // and the list stays put.
      const page = await miniflux.getEntriesPage(filter)
      generator.patchElements(
        await renderToString(<EntryList entries={page.entries} viewMode={body.viewMode ?? 'expanded'} />),
        { selector: '[data-testid="entry-list"]', mode: 'inner' },
      )
      generator.patchSignals(JSON.stringify({
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        entryIds: page.entries.map((e) => e.id),
        currentId: page.entries[0]?.id ?? 0,
      }))
    })
  })
  .put('/api/refresh', async (ctx) => {
    const body = await parseBodySignals(ctx)
    return ServerSentEventGenerator.stream(async (generator) => {
      await miniflux.refreshFeeds()
      await Bun.sleep(1500)
      const filter = body.filter ?? { status: 'unread' as const }
      const [feeds, categories, counters, page] = await Promise.all([
        miniflux.getFeeds(),
        miniflux.getCategories(),
        miniflux.getCounters(),
        miniflux.getEntriesPage(filter),
      ])
      generator.patchElements(
        await renderToString(
          <FeedPanel
            categories={categories}
            feeds={feeds}
            counters={counters.unreads}
          />,
        ),
        { selector: '[data-testid="feed-panel"]', mode: 'outer' },
      )
      generator.patchElements(
        await renderToString(<EntryList entries={page.entries} viewMode={body.viewMode ?? 'expanded'} />),
        { selector: '[data-testid="entry-list"]', mode: 'inner' },
      )
      generator.patchSignals(JSON.stringify({
        nextCursor: page.nextCursor ?? null,
        hasMore: page.hasMore,
        entryIds: page.entries.map((e) => e.id),
        currentId: page.entries[0]?.id ?? 0,
      }))
    })
  })
  .post('/api/feeds/:id/unsubscribe', async (ctx) => {
    // Full-page nav flow: delete the feed, then land on Latest. The toolbar
    // row posts a plain <form> (works without JS, CSRF-safe like logout).
    const feedId = Number(ctx.req.param('id'))
    try {
      await miniflux.deleteFeed(feedId)
    } catch (err) {
      if (!(err instanceof miniflux.MinifluxError && err.status === 404)) throw err
      // Feed already gone — treat as success.
    }
    return ctx.redirect('/')
  })

  // ---- Per-account preferences (SQLite, keyed by Miniflux user id) ----
  // Each action is a plain @put: the client toggles the signal, datastar
  // sends all signals implicitly, and the server persists the relevant one.
  // View/sort/hideReadItems are per-feed; the rest are account-wide.
  .put('/api/prefs/view-mode', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    const feedId = Number(body.filter?.feedId)
    if (userId != null && Number.isInteger(feedId) && feedId > 0) {
      saveFeedPrefs(userId, feedId, { viewMode: body.viewMode ?? 'expanded' })
    }
    return reRenderEntries(body)
  })
  .put('/api/prefs/sort', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    const feedId = Number(body.filter?.feedId)
    if (userId != null && Number.isInteger(feedId) && feedId > 0) {
      saveFeedPrefs(userId, feedId, { sort: body.filter?.sort ?? 'oldest' })
    }
    return reRenderEntries(body)
  })
  .put('/api/prefs/hide-read-items', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    const feedId = Number(body.filter?.feedId)
    if (userId != null && Number.isInteger(feedId) && feedId > 0) {
      saveFeedPrefs(userId, feedId, { hideReadItems: body.hideReadItems ?? true })
    }
    return reRenderEntries(body)
  })
  .put('/api/prefs/hide-empty-feeds', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    if (userId != null && typeof body.hideEmptyFeeds === 'boolean') {
      saveUserPrefs(userId, { hideEmptyFeeds: body.hideEmptyFeeds })
    }
    return ServerSentEventGenerator.stream(async (generator) => {
      await refreshFeedPanel(generator, body.filter)
    })
  })
  .put('/api/prefs/collapsed-cats', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    if (userId != null && body.collapsedCats) {
      saveUserPrefs(userId, { collapsedCats: body.collapsedCats })
    }
    return ctx.body(null, 204)
  })
  .put('/api/prefs/auto-read', async (ctx) => {
    const body = await parseBodySignals(ctx)
    const { userId } = readSession(ctx) ?? {}
    if (userId != null && Array.isArray(body.disabledAutoReadFeeds)) {
      saveUserPrefs(userId, { disabledAutoReadFeeds: body.disabledAutoReadFeeds })
    }
    return ctx.body(null, 204)
  })

  // ---- Inline rename (SSE; no redirect, no reload) ----
  .put('/api/categories/:id/rename', async (ctx) => {
    const categoryId = Number(ctx.req.param('id'))
    const body = await parseBodySignals(ctx)
    const title = (body.renameTitle ?? '').trim()
    if (!title) return ctx.json({ error: 'title required' }, 400)
    await miniflux.updateCategory(categoryId, title)
    return ServerSentEventGenerator.stream(async (generator) => {
      await refreshFeedPanel(generator, body.filter)
      generator.patchSignals(JSON.stringify({ renameId: null, renameKind: null, renameTitle: '' }))
    })
  })
  .put('/api/feeds/:id/rename', async (ctx) => {
    const feedId = Number(ctx.req.param('id'))
    const body = await parseBodySignals(ctx)
    const title = (body.renameTitle ?? '').trim()
    if (!title) return ctx.json({ error: 'title required' }, 400)
    await miniflux.updateFeed(feedId, title)
    return ServerSentEventGenerator.stream(async (generator) => {
      await refreshFeedPanel(generator, body.filter)
      generator.patchSignals(JSON.stringify({ renameId: null, renameKind: null, renameTitle: '' }))
    })
  })
  .get(
    '/api/feeds/:id/icon',
    etag(),
    async (ctx) => {
      const feedId = Number(ctx.req.param('id'))
      let icon
      try {
        icon = await miniflux.getFeedIcon(feedId)
      } catch (err) {
        if (err instanceof miniflux.MinifluxError && err.status === 404) {
          ctx.header('Cache-Control', 'private, max-age=3600, stale-while-revalidate=3600')
          return ctx.text('icon unavailable', 404)
        }
        throw err
      }
      const [declaredMime, base64] = icon.data.split(';base64,', 2)
      if (!base64 || !declaredMime) {
        ctx.header('Cache-Control', 'private, max-age=3600, stale-while-revalidate=3600')
        return ctx.text('icon unavailable', 404)
      }
      const bytes = Buffer.from(base64, 'base64')
      ctx.header('Cache-Control', 'private, max-age=7200, stale-while-revalidate=604800')
      return ctx.body(bytes, 200, { 'Content-Type': declaredMime })
    },
  )