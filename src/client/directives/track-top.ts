// v-track-top directive — which entry's top sits at (or just above) the top
// of the scroll container. Ported from the old datastar track-top plugin.
//
// One shared IntersectionObserver per scroll root observes every
// [data-track-top] entry. On each batch it records each entry's top/bottom
// (relative to the container top) and picks a single deterministic winner —
// the topmost still-visible entry — via pickTopmostVisible, instead of
// letting whichever observer fires last win. Handles tall expanded entries
// (no threshold dead-zone) and avoids flickering between two entries during a
// handoff.
//
// The first observe() callback is skipped: at load the list is unselected
// (currentId === 0) and the top entry already sits in the band, so lifting
// the initialized guard would re-select it before the user ever navigates.
// Subsequent scrolls (a real change) sync currentId as before.

import type { Directive } from 'vue'
import { useReaderStore } from '@/client/stores/reader'
import { pickTopmostVisible, type TrackedRect } from '@/shared/reading'

interface TrackTopState {
  observer: IntersectionObserver
  registry: Map<number, TrackedRect>
  initialized: boolean
  /** reader store pageGen last seen; when it moves we re-arm the init guard. */
  pageGen: number
}

const stateByRoot = new WeakMap<Element, TrackTopState>()

function getScrollRoot(el: Element): Element {
  return el.closest('[data-testid="entry-list"]')?.parentElement ?? document.body
}

export const vTrackTop: Directive<HTMLElement, number> = {
  mounted(el, binding) {
    const entryId = Number(binding.value)
    const reader = useReaderStore()
    const scrollRoot = getScrollRoot(el)
    let state = stateByRoot.get(scrollRoot)
    if (!state) {
      const registry = new Map<number, TrackedRect>()
      const observer = new IntersectionObserver(

        (entries) => {
          const st = state!
          const isFirst = !st.initialized
          if (isFirst) {
            // Record initial geometry (so a subsequent scroll picks up the
            // correct top) but don't write currentId yet.
            for (const entry of entries) {
              if (!entry.rootBounds) continue
              const top = entry.boundingClientRect.top - entry.rootBounds.top
              const bottom = entry.boundingClientRect.bottom - entry.rootBounds.top
              registry.set(Number(entry.target.getAttribute('data-track-top')), { top, bottom })
            }
            st.initialized = true
            return
          }
          for (const entry of entries) {
            if (!entry.rootBounds) continue
            const top = entry.boundingClientRect.top - entry.rootBounds.top
            const bottom = entry.boundingClientRect.bottom - entry.rootBounds.top
            registry.set(Number(entry.target.getAttribute('data-track-top')), { top, bottom })
          }
          const best = pickTopmostVisible(registry)
          if (best != null) {
            useReaderStore().currentId = best
          }
        },
        {
          root: scrollRoot,
          // Only the sliver at the very top of the container triggers.
          rootMargin: '0px 0px -95% 0px',
          threshold: 0,
        },
      )
      state = { observer, registry, initialized: false, pageGen: reader.pageGen }
      stateByRoot.set(scrollRoot, state)
    }
    // A new page replaced the list (navigation): re-arm the init guard so the
    // freshly-loaded list stays unselected (currentId 0) until the user scrolls
    // or presses j — the same as a full page load. Without this, the selected
    // state from the previous feed carries over and the first j lands on item 2.
    if (state.pageGen !== reader.pageGen) {
      state.pageGen = reader.pageGen
      state.initialized = false
      state.registry.clear()
    }
    el.setAttribute('data-track-top', String(entryId))
    state.observer.observe(el)
  },
  unmounted(el) {
    const scrollRoot = getScrollRoot(el)
    const state = stateByRoot.get(scrollRoot)
    if (state) {
      const entryId = Number(el.getAttribute('data-track-top'))
      state.registry.delete(entryId)
      state.observer.unobserve(el)
    }
  },
}
