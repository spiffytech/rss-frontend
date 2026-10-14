/**
 * Shared UI helpers — ported from the old app's src/shared/util.ts (minus
 * lazyHtml, which dies with the old display path: the display pipeline in
 * src/client/display/ owns content rendering now). Ids are UUIDv7 strings
 * here instead of Miniflux integers; the logic is verbatim.
 */

/**
 * Unread count for the current filter, computed from per-feed counters (the
 * provider source of truth). Returns null when the count is not meaningful
 * (e.g. Starred has no per-feed unread breakdown here).
 */
export function computeUnreadCount(
  filter: { feedId?: string; categoryId?: string; starred?: boolean },
  feeds: Array<{ id: string; categoryId?: string }>,
  unreads: Record<string, number>,
): number | null {
  if (filter.feedId != null && filter.feedId !== '') {
    return unreads[filter.feedId] ?? 0
  }
  if (filter.starred) {
    return null
  }
  if (filter.categoryId != null && filter.categoryId !== '') {
    return feeds
      .filter((f) => f.categoryId === filter.categoryId)
      .reduce((sum, f) => sum + (unreads[f.id] ?? 0), 0)
  }
  // Latest: sum of all per-feed unread counts.
  return Object.values(unreads).reduce((a, b) => a + b, 0)
}

/** Compact relative-time label ("5m", "3d", "2y"). */
export function timeAgo(ms: number): string {
  if (Number.isNaN(ms)) return ''
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
