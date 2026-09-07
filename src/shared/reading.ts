// Pure reading-pane decision logic — DOM-free so it's unit-testable under
// `bun test`. The directives/composables in src/client wire these to real
// IntersectionObservers and stores.

export interface TrackedRect {
  top: number
  bottom: number
}

/**
 * Pick the single deterministic winner among tracked entries: the topmost
 * entry still visible (bottom > 0) in the scroll container. Mirrors the old
 * datastar track-top plugin (one shared observer + registry per scroll root).
 */
export function pickTopmostVisible(
  registry: ReadonlyMap<number, TrackedRect>,
): number | null {
  let best: number | null = null
  let bestTop = Infinity
  for (const [entryId, r] of registry) {
    if (r.bottom <= 0) continue
    if (r.top < bestTop) {
      bestTop = r.top
      best = entryId
    }
  }
  return best
}

/**
 * Auto-read guard: should the scroll-driven auto-read fire for this entry?
 * Mirrors the old `data-on-intersect-line` expression:
 *   $userHasScrolled && !$disabledAutoReadFeeds.includes(feed_id)
 *     && !$keepUnreadIds.includes(id)
 * (the entry must also be unread — the server re-checks as a second line of
 * defense, but the client shouldn't fire the request for read entries).
 */
export function shouldAutoRead(opts: {
  viewMode: 'expanded' | 'list'
  userHasScrolled: boolean
  disabledAutoReadFeeds: readonly number[]
  keepUnreadIds: readonly number[]
  feedId: number
  entryId: number
  status: 'read' | 'unread'
}): boolean {
  return (
    opts.viewMode === 'expanded' &&
    opts.userHasScrolled &&
    !opts.disabledAutoReadFeeds.includes(opts.feedId) &&
    !opts.keepUnreadIds.includes(opts.entryId) &&
    opts.status === 'unread'
  )
}

/**
 * Sweep guard: is the entry entirely above the auto-read band line (given in
 * the same coordinate space as the rect)? A transition-only band observer
 * misses crossings that complete between two of its evaluations (fast flicks,
 * momentum scrolling) — an entry sitting entirely above the band has by
 * definition been scrolled past, so the sweep can auto-read it regardless of
 * whether the crossing was ever observed.
 */
export function isScrolledPast(
  rect: TrackedRect,
  bandY: number,
): boolean {
  return rect.bottom < bandY
}

/** Clamp a nav index into [0, length-1]; 0 when the list is empty. */
export function clampNavIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}
