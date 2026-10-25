/**
 * Scroll-into-view for keyboard navigation — the old scrollNav rAF loop: linear
 * interpolation over a fixed budget, driving real scrollTop (not a transform) so
 * the track-top and sweep observers all see genuine scrolling. Honors
 * prefers-reduced-motion with an instant jump.
 */
import type { EntryId } from '../shared/ids'

const SCROLL_MS = 150

export const scrollToEntry = (entryId: EntryId): void => {
  const el = document.getElementById(`entry-${entryId}`)
  if (!el) return
  const scroller = el.closest('[data-testid="entry-list"]')?.parentElement ?? el.offsetParent
  if (!(scroller instanceof HTMLElement)) return
  const to = scroller.scrollTop + (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
  const from = scroller.scrollTop
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scroller.scrollTop = to
    return
  }
  let start: number | undefined
  const step = (ts: number) => {
    if (start === undefined) start = ts
    const progress = Math.min(1, (ts - start) / SCROLL_MS)
    scroller.scrollTop = from + (to - from) * progress
    if (progress < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}
