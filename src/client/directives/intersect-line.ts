// v-intersect-line directive — auto-read when an unread entry scrolls into
// the reading band (expanded view only). Ported from the old datastar
// on-intersect-line plugin.
//
// Two mechanisms:
//
// 1. Transition path (fast): a per-entry IntersectionObserver whose root is
//    the scroll container, with a band at 15% of the viewport
//    (`-15% 0 -85% 0`). Entering the band fires auto-read. The first
//    observe() callback is skipped: a freshly patched row sitting on the line
//    shouldn't auto-read immediately. The top-of-list entry sits above the
//    band at load, so it never produces a positive "entering the band"
//    crossing in the scroll-down direction — catch it once on the first
//    scroll while it still intersects the band, guarded by userHasScrolled.
//
// 2. Sweep path (catch-up): a scroll can complete an entire crossing between
//    two observer evaluations (fast flicks, momentum scrolling while the main
//    thread is busy) — the entry then sits entirely above the band without
//    ever having been observed intersecting it, and a transition-only
//    observer never fires. A shared rAF-throttled scroll sweep per scroll
//    root re-checks live geometry: an entry entirely above the band line has
//    by definition been scrolled past, so it's auto-read no matter how it got
//    there. Sweeps are also scheduled from observer callbacks, covering
//    crossings the observer reports late and layout shifts. The store's
//    autoRead guard (userHasScrolled, status, keep-unread, disabled feeds)
//    makes redundant fires a no-op, so sweeping needs no bookkeeping of its
//    own; a member is dropped after firing.
//
// Live state is read from the stores in fire() (viewMode, entry status,
// keepUnreadIds, userHasScrolled) — the bound props are just the stable
// ids — so a row that becomes read stops auto-reading without re-mounting.

import type { Directive } from 'vue'
import { useReaderStore } from '@/client/stores/reader'
import { isScrolledPast } from '@/shared/reading'

/** Band line position from the top of the scroll root; matches the
 * observer's `-15% 0 -85% 0` rootMargin. */
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
      if (isScrolledPast(member.el.getBoundingClientRect(), bandY)) {
        state.members.delete(member)
        member.fire()
      }
    }
  })
}

export const vIntersectLine: Directive<HTMLElement, { entryId: number; feedId: number }> = {
  mounted(el, binding) {
    const { entryId, feedId } = binding.value
    const reader = useReaderStore()
    const scrollRoot = getScrollRoot(el)
    let initialized = false
    let intersecting = false

    function fire() {
      // The store's autoRead owns the full guard (viaScroll=true keeps the
      // userHasScrolled requirement) — same path as j/k/buttons/click.
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

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!initialized) {
            // Record the initial state; don't fire yet — a freshly patched row
            // sitting on the line shouldn't auto-read immediately.
            initialized = true
            intersecting = entry.isIntersecting
            continue
          }
          if (entry.isIntersecting) {
            intersecting = true
            fire()
          } else {
            intersecting = false
          }
        }
        // Any observer update is also a chance to catch crossings that
        // completed between evaluations (and post-layout geometry changes).
        scheduleSweep(scrollRoot, sweep!)
      },
      {
        root: scrollRoot,
        rootMargin: '-15% 0px -85% 0px',
        threshold: 0,
      },
    )
    observer.observe(el)

    // The first entry's top sits above the line at load, so it never produces
    // a positive "entering the band" crossing in the scroll-down direction.
    // (The sweep can't catch it while it still spans the band.) Catch it once
    // on the first scroll while it still intersects the band.
    const onFirstScroll = () => {
      if (initialized && intersecting) {
        reader.userHasScrolled = true
        fire()
      }
      scrollRoot.removeEventListener('scroll', onFirstScroll)
    }
    scrollRoot.addEventListener('scroll', onFirstScroll, { passive: true })

    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup = () => {
      observer.disconnect()
      scrollRoot.removeEventListener('scroll', onFirstScroll)
      sweep!.members.delete(member)
    }
  },
  unmounted(el) {
    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup?.()
  },
}
