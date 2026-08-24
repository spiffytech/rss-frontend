// Miniflux provider — implements the Provider interface over the typed
// Miniflux REST client (src/server/lib/miniflux.ts). The lib's request()
// reads the session credential from AsyncLocalStorage; routes wrap each
// request in minifluxContext.run({ token }, …) so this provider stays
// stateless and per-request-scoped.

import * as mf from '../lib/miniflux'
import type { Provider } from './types'

export const minifluxProvider: Provider = {
  async authenticate(username, password) {
    try {
      const { id, username: name } = await mf.authenticateWithPassword(username, password)
      const { id: keyId, token } = await mf.createApiKeyAs(
        username,
        password,
        `miniflux-frontend session ${new Date().toISOString()}`,
      )
      return { ok: true, userId: id, username: name, keyId, token }
    } catch (err) {
      if (err instanceof mf.MinifluxError && (err.status === 401 || err.status === 403)) {
        return { ok: false, status: 401 }
      }
      throw err
    }
  },

  async revokeKey(keyId) {
    try {
      await mf.deleteApiKey(keyId)
    } catch {
      // Key may already be gone (revoked elsewhere); best-effort.
    }
  },

  getFeeds: () => mf.getFeeds(),
  getCategories: () => mf.getCategories(),
  getCounters: () => mf.getCounters(),
  getEntriesPage: (filter, cursor) => mf.getEntriesPage(filter, cursor),
  getEntry: (id) => mf.getEntry(id),
  markEntries: (ids, status) => mf.markEntries(ids, status),
  toggleBookmark: (id) => mf.toggleBookmark(id),
  refreshFeeds: () => mf.refreshFeeds(),
  deleteFeed: (id) => mf.deleteFeed(id),
  updateCategory: (id, title) => mf.updateCategory(id, title),
  updateFeed: (id, title) => mf.updateFeed(id, title),
  getFeedIcon: (id) => mf.getFeedIcon(id),

  /**
   * Mark everything matching a filter read without shipping id lists from the
   * client.
   *  - feedId → native PUT /feeds/:id/mark-all-as-read
   *  - categoryId → native PUT /categories/:id/mark-all-as-read
   *  - starred → /entries/ids (ids endpoint honors starred)
   *  - search → no native endpoint and /entries/ids ignores search, so iterate
   *    pages of unread search results server-side and mark each page
   *  - else (Latest / all user entries) → native PUT /users/:id/mark-all-as-read
   */
  async markAllReadByFilter(filter, userId) {
    const { feedId, categoryId, starred, search } = filter
    if (feedId != null && feedId !== '') {
      await mf.markFeedAllRead(Number(feedId))
      return
    }
    if (categoryId != null && categoryId !== '') {
      await mf.markCategoryAllRead(Number(categoryId))
      return
    }
    if (starred) {
      const ids = await mf.getEntryIds({ status: 'unread', starred: true })
      if (ids.length > 0) await mf.markEntries(ids, 'read')
      return
    }
    if (search) {
      await mf.markSearchAllRead(search)
      return
    }
    await mf.markUserAllRead(userId)
  },
}
