// useNav — scroll-into-view for keyboard navigation. Ported from the old
// scrollNav rAF loop: linear interpolation over a fixed budget, driving real
// scrollTop (not a transform) so track-top / auto-read / sentinel observers
// all see genuine scrolling. Honors prefers-reduced-motion with an instant
// jump. Returns a function that scrolls to a given entry id.

import { useReaderStore } from '@/client/stores/reader'

const SCROLL_MS = 150

export function scrollToEntry(entryId: number): void {
  const el = document.getElementById(`entry-${entryId}`)
  if (!el) return
  const scroller =
    el.closest('[data-testid="entry-list"]')?.parentElement ?? el.offsetParent
  if (!scroller) return
  const to =
    scroller.scrollTop +
    (el.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
  const from = scroller.scrollTop
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    scroller.scrollTop = to
    return
  }
  let start: number | undefined
  const step = (ts: number) => {
    if (start === undefined) start = ts
    const p = Math.min(1, (ts - start) / SCROLL_MS)
    scroller.scrollTop = from + (to - from) * p
    if (p < 1) requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/**
 * Watch navRequest and scroll to it, then clear it. Self-clearing so a nav
 * request can't re-trigger; the scroll watcher never writes currentId, so
 * user scroll → currentId patch → no scrollIntoView loop.
 */
export function useNav() {
  const reader = useReaderStore()
  // Called from a watcher in the component (or a small watch here).
  return (id: number) => {
    scrollToEntry(id)
    reader.navRequest = null
  }
}
