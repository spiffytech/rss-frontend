/**
 * Reading-pane observers: the scroll sweep (auto-read what you scrolled past) and
 * the end-of-list sentinel.
 *
 * Browser-only, and per page: they read and write the page's reader, which is
 * passed in rather than imported, so nothing here depends on ambient state.
 *
 * There is deliberately **no** IntersectionObserver tracking "the card at the
 * top": that question is answered from geometry when it is asked (see
 * `anchorIndex` in the reader), because an observer's report lags a fast or
 * programmatic scroll, and a stale answer made Prev/Next move relative to a card
 * that had already left the screen.
 */
import { BAND_FRACTION, isScrolledPast } from '../shared/reading'
import type { EntryId } from '../shared/ids'
import type { Reader } from './reader'

type Member = { el: HTMLElement; entryId: EntryId }

const members = new Set<Member>()
let rafId: number | null = null

/** The reading pane's scroll container, resolved at use time (it may not exist yet). */
const scrollContainer = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="entry-scroll"]')

/**
 * One pass over the cards: anything whose top edge has risen above the reading
 * band was scrolled past, so the sweep marks it read.
 *
 * Call it from the scroll handler. It coalesces to one pass per frame.
 */
export const sweep = (r: Reader): void => {
  if (rafId != null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    // autoRead owns the full guard; this is just the cheapest pre-check.
    if (!r.session.userHasScrolled) return
    const container = scrollContainer()
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const bandY = containerRect.top + containerRect.height * BAND_FRACTION
    for (const member of [...members]) {
      if (!member.el.isConnected) {
        members.delete(member)
      } else if (isScrolledPast(member.el.getBoundingClientRect(), bandY)) {
        members.delete(member)
        r.autoRead(member.entryId, true) // viaScroll: requires userHasScrolled
      }
    }
  })
}

/**
 * The one scroll listener for the reading pane: it arms the sweep, records
 * end-of-list (which gates the idle-time tail recheck) and asks the sweep for a
 * pass. Capture on the document, because a scroll event does not bubble.
 *
 * Returns the cleanup.
 */
export const watchScroll = (r: Reader): (() => void) => {
  const onScroll = (): void => {
    const container = scrollContainer()
    if (!container) return
    // A scroll landing at scrollTop 0 is our own programmatic reset when a fresh
    // list replaces the old one — not user intent. Without this, opening a feed
    // arms the auto-read sweep and marks its first entry read.
    const scrolled = container.scrollTop !== 0
    const atEnd = container.scrollTop + container.clientHeight >= container.scrollHeight - 200
    r.setSession((draft) => {
      if (scrolled) draft.userHasScrolled = true
      draft.atListEnd = atEnd
    })
    if (scrolled) sweep(r)
  }
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
  return () => document.removeEventListener('scroll', onScroll, { capture: true })
}

/**
 * Track one entry card for the sweep. Call from a `ref` callback; the returned
 * function is the cleanup.
 */
export const trackEntry = (node: HTMLElement, entryId: EntryId): (() => void) => {
  const member: Member = { el: node, entryId }
  members.add(member)
  return () => {
    members.delete(member)
  }
}

/**
 * Scroll sentinel for windowed views: fires on every intersection including the
 * initial mount report, so an under-filled viewport immediately pulls the next
 * window. The caller guards with `nextCursor && !loadingMore`.
 */
export const observeSentinel = (
  node: HTMLElement,
  fire: () => void | Promise<void>,
): (() => void) => {
  const sentinel = new IntersectionObserver(
    (batch) => {
      for (const item of batch) if (item.isIntersecting) void fire()
    },
    { root: scrollContainer(), rootMargin: '0px 0px 400px 0px', threshold: 0 },
  )
  sentinel.observe(node)
  return () => sentinel.disconnect()
}

/**
 * Focus an element the moment it mounts (rename editors).
 *
 * Deferred by a microtask: a ref callback runs while the element is still being
 * inserted, and an element that is not yet in the document cannot take focus.
 */
export const autofocus = (node: HTMLElement): void => {
  queueMicrotask(() => node.focus())
}
