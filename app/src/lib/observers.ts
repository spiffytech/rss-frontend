/**
 * Reading-pane observers: the reading-anchor observer, the scroll sweep and the
 * end-of-list sentinel.
 *
 * Browser-only, and per page: they read and write the page's reader, which is
 * passed in rather than imported, so nothing here depends on ambient state.
 */
import { untrack } from 'solid-js'

import { isScrolledPast, pickTopmostVisible, type TrackedRect } from '../shared/reading'
import type { EntryId } from '../shared/ids'
import type { Reader } from './reader'

const BAND_FRACTION = 0.15

type Member = { el: HTMLElement; entryId: EntryId }

const members = new Set<Member>()
const registry = new Map<EntryId, TrackedRect>()
let observer: IntersectionObserver | null = null
let initialized = false
let seenPageGen = 0
let rafId: number | null = null
let listening = false

/** The reading pane's scroll container, resolved at use time (it may not exist yet). */
const scrollContainer = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="entry-scroll"]')

const scheduleSweep = (r: Reader): void => {
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

const onScroll = (r: Reader): void => {
  // A scroll landing at scrollTop 0 is our own programmatic reset when a fresh
  // list replaces the old one — not user intent. Without this, opening a feed
  // arms the auto-read sweep and marks its first entry read.
  if ((scrollContainer()?.scrollTop ?? 0) !== 0) {
    r.setSession((draft) => {
      draft.userHasScrolled = true
    })
  }
  scheduleSweep(r)
}

const ensureObserver = (r: Reader): IntersectionObserver => {
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
        r.setSession((draft) => {
          draft.currentId = best
        })
      }
    },
    { rootMargin: '0px 0px -95% 0px', threshold: 0 },
  )
  return observer
}

let bound: Reader | null = null

const ensureInstalled = (r: Reader): void => {
  if (listening) return
  listening = true
  bound = r
  document.addEventListener('scroll', () => bound && onScroll(bound), {
    capture: true,
    passive: true,
  })
}

/**
 * Track one entry card: geometry for the reading anchor, and membership in the
 * scroll sweep. Call from a `ref` callback; the returned function is the cleanup.
 */
export const trackEntry = (
  r: Reader,
  node: HTMLElement,
  entryId: EntryId,
): (() => void) => {
  ensureInstalled(r)
  const entries = ensureObserver(r)

  // A new list replaced the old one: re-arm the init guard so the fresh list
  // starts unselected (currentId stays null until scroll or j).
  // A ref callback has no tracking scope; this is a compare-and-store, not a
  // dependency, so the generation is read untracked on purpose.
  const pageGen = untrack(() => r.session.pageGen)
  if (seenPageGen !== pageGen) {
    seenPageGen = pageGen
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
