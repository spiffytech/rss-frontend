// v-intersect-line directive — auto-read when the user scrolls an entry's
// start past a line near the top of the scroll container (expanded view
// only). Replaces the old transition-based design (per-entry
// IntersectionObserver band, rAF sweep catch-up, first-observe skip,
// first-scroll hack): the trigger is now a pure STATE test driven only by
// scroll events, so there is no crossing to miss.
//
// The predicate is absolute: an entry's top edge enters the scroll root at
// the bottom and crosses the band line (15% from the top) after exactly
// 0.85vh of scrolling — for every entry, short or tall. A tall article is
// therefore marked read while still on screen, mid-read; that's the accepted
// trade-off. Visibility alone marks nothing: the sweep is gated on
// userHasScrolled, and autoRead owns the full guard (keep-unread, disabled
// feeds, status).
//
// Live state is read from the stores in fire() — the bound props are just
// the stable ids — so a row that becomes read stops auto-reading without
// re-mounting. A member is dropped after firing so a scroll never re-fires
// it; the store's guard would no-op the request anyway.

import type { Directive } from 'vue'
import { useReaderStore } from '@/client/stores/reader'
import { isScrolledPast } from '@/shared/reading'

/** Band line position from the top of the scroll root. */
const BAND_FRACTION = 0.15

function getScrollRoot(el: Element): Element {
  return el.closest('[data-testid="entry-list"]')?.parentElement ?? document.body
}

interface SweepMember {
  el: HTMLElement
  fire: () => void
}

interface SweepState {
  members: Set<SweepMember>
  rafId: number | null
}

const sweepByRoot = new WeakMap<Element, SweepState>()

function scheduleSweep(root: Element, state: SweepState): void {
  if (state.rafId != null) return
  state.rafId = requestAnimationFrame(() => {
    state.rafId = null
    const reader = useReaderStore()
    // Mirrors the autoRead viaScroll guard's cheapest check; autoRead owns
    // the full guard either way.
    if (!reader.userHasScrolled) return
    const rootRect = root.getBoundingClientRect()
    const bandY = rootRect.top + rootRect.height * BAND_FRACTION
    for (const member of state.members) {
      // One read per member, no interleaved writes — batched by the browser.
      if (!member.el.isConnected) {
        state.members.delete(member)
      } else if (isScrolledPast(member.el.getBoundingClientRect(), bandY)) {
        state.members.delete(member)
        member.fire()
      }
    }
  })
}

export const vIntersectLine: Directive<HTMLElement, { entryId: number; feedId: number }> = {
  mounted(el, binding) {
    const { entryId } = binding.value
    const reader = useReaderStore()
    const scrollRoot = getScrollRoot(el)

    function fire() {
      // The store's autoRead owns the full guard — same path as j/k/buttons.
      reader.autoRead(entryId, true)
    }

    // Register with the shared sweep for this scroll root.
    let sweep = sweepByRoot.get(scrollRoot)
    if (!sweep) {
      sweep = { members: new Set(), rafId: null }
      sweepByRoot.set(scrollRoot, sweep)
      scrollRoot.addEventListener(
        'scroll',
        () => scheduleSweep(scrollRoot, sweep!),
        { passive: true },
      )
    }
    const member: SweepMember = { el, fire }
    sweep.members.add(member)

    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup = () => {
      sweep!.members.delete(member)
    }
  },
  unmounted(el) {
    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup?.()
  },
}
