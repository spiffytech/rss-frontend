/**
 * Scroll-into-view for keyboard navigation.
 *
 * Instant, on purpose: Prev/Next is a keyboard gesture and the old rAF tween made
 * it feel like it was waiting on the write that follows. Setting scrollTop still
 * drives real scrolling, so the track-top and sweep observers see it.
 */
import type { EntryId } from '../shared/ids'

export const scrollToEntry = (entryId: EntryId): void => {
  const el = document.getElementById(`entry-${entryId}`)
  if (!el) return
  const scroller = el.closest('[data-testid="entry-list"]')?.parentElement ?? el.offsetParent
  if (!(scroller instanceof HTMLElement)) return
  scroller.scrollTop =
    scroller.scrollTop + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
}
