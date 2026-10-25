/**
 * Reading-pane observers: the reading-anchor observer, the scroll sweep and the
 * end-of-list sentinel.
 *
 * These replace the Svelte actions of the same names. Behaviour is unchanged;
 * the shape is simpler because this app has exactly one reading pane:
 *
 *  - **One** document-level scroll listener (capture, so it sees the container's
 *    non-bubbling scroll) rather than one per scroll root.
 *  - **One** IntersectionObserver over every card, viewport-rooted, so observing
 *    never depends on the card already being attached to its container.
 *  - Geometry is read at sweep time, not at ref time.
 *
 * The last point is the reason for the rewrite: a ref callback runs while the
 * element is still being created, so `node.closest(...)` is null there and a
 * ref-time listener lands on the wrong element — silently, and the auto-read
 * sweep never fires again.
 */
import { isScrolledPast, pickTopmostVisible, type TrackedRect } from '../shared/reading'
import type { EntryId } from '../shared/ids'
import { autoRead, reader, setReader } from './state'

const BAND_FRACTION = 0.15

type Member = { el: HTMLElement; entryId: EntryId }

const members = new Set<Member>()
const registry = new Map<EntryId, TrackedRect>()
let observer: IntersectionObserver | null = null
let initialized = false
let seenPageGen = reader.pageGen
let rafId: number | null = null
let listening = false

/** The reading pane's scroll container, resolved at use time (it may not exist yet). */
const scrollContainer = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="entry-scroll"]')

const scheduleSweep = (): void => {
  if (rafId != null) return
  rafId = requestAnimationFrame(() => {
    rafId = null
    // autoRead owns the full guard; this is just the cheapest pre-check.
    if (!reader.userHasScrolled) return
    const container = scrollContainer()
    if (!container) return
    const containerRect = container.getBoundingClientRect()
    const bandY = containerRect.top + containerRect.height * BAND_FRACTION
    for (const member of [...members]) {
      if (!member.el.isConnected) {
        members.delete(member)
      } else if (isScrolledPast(member.el.getBoundingClientRect(), bandY)) {
        members.delete(member)
        autoRead(member.entryId, true) // viaScroll: requires userHasScrolled
      }
    }
  })
}

const onScroll = (): void => {
  // A scroll landing at scrollTop 0 is our own programmatic reset when a fresh
  // list replaces the old one — not user intent. Without this, opening a feed
  // arms the auto-read sweep and marks its first entry read.
  if ((scrollContainer()?.scrollTop ?? 0) !== 0) {
    setReader((state) => {
      state.userHasScrolled = true
    })
  }
  scheduleSweep()
}

const ensureObserver = (): IntersectionObserver => {
  if (observer) return observer
  observer = new IntersectionObserver(
    (batch) => {
      for (const item of batch) {
        if (!item.rootBounds) continue
        const id = item.target.getAttribute('data-track-top')
        if (!id) continue
        registry.set(id as EntryId, {
          top: item.boundingClientRect.top - item.rootBounds.top,
          bottom: item.boundingClientRect.bottom - item.rootBounds.top,
        })
      }
      if (!initialized) {
        // First batch after (re)load records geometry only: the list starts
        // unselected so navigating to a feed never inherits the last anchor.
        initialized = true
        return
      }
      const best = pickTopmostVisible(registry)
      if (best != null) {
        setReader((state) => {
          state.currentId = best
        })
      }
    },
    { rootMargin: '0px 0px -95% 0px', threshold: 0 },
  )
  return observer
}

const ensureInstalled = (): void => {
  if (listening) return
  listening = true
  document.addEventListener('scroll', onScroll, { capture: true, passive: true })
}

/**
 * Track one entry card: geometry for the reading anchor, and membership in the
 * scroll sweep. Call from a `ref` callback; the returned function is the cleanup.
 */
export const trackEntry = (node: HTMLElement, entryId: EntryId): (() => void) => {
  ensureInstalled()
  const entries = ensureObserver()

  // A new list replaced the old one: re-arm the init guard so the fresh list
  // starts unselected (currentId stays null until scroll or j).
  if (seenPageGen !== reader.pageGen) {
    seenPageGen = reader.pageGen
    initialized = false
    registry.clear()
    members.clear()
  }

  node.setAttribute('data-track-top', entryId)
  entries.observe(node)
  const member: Member = { el: node, entryId }
  members.add(member)

  return () => {
    registry.delete(entryId)
    members.delete(member)
    entries.unobserve(node)
  }
}

/**
 * Scroll sentinel for windowed views: fires on every intersection including the
 * initial mount report, so an under-filled viewport immediately pulls the next
 * window. The caller guards with `nextCursor && !loadingMore`.
 */
export const observeSentinel = (node: HTMLElement, fire: () => Promise<void>): (() => void) => {
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
