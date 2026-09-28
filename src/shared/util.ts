import type { EntriesFilter } from './filter'

/**
 * Unread count for the current filter, computed from per-feed counters (the
 * provider source of truth). Returns null when the count is not meaningful
 * (e.g. Starred has no per-feed unread breakdown here).
 */
export function computeUnreadCount(
  filter: { feedId?: number | string; categoryId?: number | string; starred?: boolean },
  feeds: Array<{ id: number; category?: { id: number } | null }>,
  unreads: Record<string, number>,
): number | null {
  if (filter.feedId != null && filter.feedId !== '') {
    return unreads[Number(filter.feedId)] ?? 0
  }
  if (filter.starred) {
    return null
  }
  if (filter.categoryId != null && filter.categoryId !== '') {
    const catId = Number(filter.categoryId)
    return feeds
      .filter((f) => f.category?.id === catId)
      .reduce((sum, f) => sum + (unreads[f.id] ?? 0), 0)
  }
  // Latest: sum of all per-feed unread counts.
  return Object.values(unreads).reduce((a, b) => a + b, 0)
}

/** Compact relative-time label ("5m", "3d", "2y"). */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
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

/**
 * Client-side post-processing of entry HTML: adds `loading="lazy"` to all
 * iframe and img elements so off-screen embeds don't render until scrolled
 * into view, and gives embeds an explicit aspect-ratio. An iframe has no
 * intrinsic ratio, so `max-width: 100%` alone would shrink its width while
 * leaving the height attribute fixed (a distorted embed); deriving the ratio
 * from width/height makes the height scale with the width.
 * Mirrors the old server-side lazyHtml (kept client-side now that the API
 * returns raw content).
 */
export function lazyHtml(html: string): string {
  // Only add loading="lazy" if not already present.
  return html
    .replace(/<(iframe|img)(\s)(?![^>]*loading=)/gi, '<$1$2loading="lazy" ')
    .replace(/<iframe\b[^>]*>/gi, (tag) => {
      // Numeric width/height only: percentage widths are already responsive and
      // have no ratio to derive.
      const w = tag.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(?![\d.%])/i)
      const h = tag.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)(?![\d.%])/i)
      if (!w || !h) return tag
      const ratio = `${w[1]} / ${h[1]}`
      if (/(\bstyle\s*=\s*)(["'])/i.test(tag)) {
        return tag.replace(
          /(\bstyle\s*=\s*)(["'])/i,
          (_m, pre, quote) => `${pre}${quote}aspect-ratio:${ratio};`,
        )
      }
      return tag.replace(/^<iframe\b/i, `<iframe style="aspect-ratio:${ratio};"`)
    })
}

export type { EntriesFilter }
