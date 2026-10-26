// Pure reading-pane decision logic — DOM-free so it's unit-testable under
// `bun test`. Logic verbatim from the old app's src/shared/reading.ts; only
// the id types changed (UUIDv7 brands instead of Miniflux integers).
// The actions in src/client/actions.ts wire these to real observers.

import type { EntryId, FeedId } from './ids'

export interface TrackedRect {
  top: number
  bottom: number
}

/**
 * Height of the reading band at the top of the scroll container, as a fraction of
 * its height. One constant for both users of the band: the scroll sweep (what
 * did I scroll past?) and the keyboard anchor (what am I looking at?).
 */
export const BAND_FRACTION = 0.15

/**
 * Auto-read guard: should the scroll-driven auto-read fire for this entry?
 *   $userHasScrolled && !$disabledAutoReadFeeds.includes(feed_id)
 *     && !$keepUnreadIds.includes(id)
 * (the entry must also be unread — the server re-checks as a second line of
 * defense, but the client shouldn't fire the request for read entries).
 */
export function shouldAutoRead(opts: {
  viewMode: 'expanded' | 'list'
  userHasScrolled: boolean
  disabledAutoReadFeeds: readonly FeedId[]
  keepUnreadIds: readonly EntryId[]
  feedId: FeedId
  entryId: EntryId
  status: 'read' | 'unread'
  /**
   * Card clicks mark read even when the feed has mark-read-on-scroll
   * disabled: the setting governs passive marking; an explicit click on the
   * entry is a deliberate "I'm through with this".
   */
  ignoreFeedSetting?: boolean
  /**
   * A direct human action (clicking the entry to expand it) reads even in
   * list view, where collapsed content normally keeps auto-read off.
   * Bypasses only the view-mode gate, not the keep-unread/feed guards.
   */
  explicit?: boolean
}): boolean {
  return (
    (opts.explicit || opts.viewMode === 'expanded') &&
    opts.userHasScrolled &&
    (opts.ignoreFeedSetting || !opts.disabledAutoReadFeeds.includes(opts.feedId)) &&
    !opts.keepUnreadIds.includes(opts.entryId) &&
    opts.status === 'unread'
  )
}

/**
 * Sweep guard: has the entry's top edge risen above the band line (given in
 * the same coordinate space as the rect)? The trigger is absolute — every
 * entry, short or tall, crosses the line after the same amount of scrolling,
 * because the test is on the entry's top edge, not its bottom. A pure state
 * test also can't miss the way transition observers can (mounts straddling
 * the line, crossings completed between evaluations): whatever got the entry
 * here, if its top is above the line the user scrolled it past.
 */
export function isScrolledPast(rect: TrackedRect, bandY: number): boolean {
  return rect.top < bandY
}

/** Clamp a nav index into [0, length-1]; 0 when the list is empty. */
export function clampNavIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}
