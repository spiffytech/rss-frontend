// v-intersect-line directive — auto-read when an unread entry scrolls into
// the reading band (expanded view only). Ported from the old datastar
// on-intersect-line plugin.
//
// The observer root is the scroll container (entry-list's parent), with a
// band at the middle of the viewport (`-15% 0 -85% 0`). The first observe()
// callback is skipped: a freshly patched row sitting on the line shouldn't
// auto-read immediately. The top-of-list entry sits above the band at load,
// so it never produces a positive "entering the band" crossing in the
// scroll-down direction — catch it once on the first scroll while it still
// intersects the band, guarded by userHasScrolled.
//
// Live state is read from the stores in fire() (viewMode, entry status,
// keepUnreadIds, userHasScrolled) — the bound props are just the stable
// ids — so a row that becomes read stops auto-reading without re-mounting.

import type { Directive } from 'vue'
import { useReaderStore } from '@/client/stores/reader'
import { useFeedsStore } from '@/client/stores/feeds'
import { shouldAutoRead } from '@/shared/reading'

function getScrollRoot(el: Element): Element {
  return el.closest('[data-testid="entry-list"]')?.parentElement ?? document.body
}

export const vIntersectLine: Directive<HTMLElement, { entryId: number; feedId: number }> = {
  mounted(el, binding) {
    const { entryId, feedId } = binding.value
    const reader = useReaderStore()
    const feeds = useFeedsStore()
    const scrollRoot = getScrollRoot(el)
    let initialized = false
    let intersecting = false

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
    // Catch it once on the first scroll while it still intersects the band.
    const onScroll = () => {
      if (initialized && intersecting) {
        reader.userHasScrolled = true
        fire()
      }
      scrollRoot.removeEventListener('scroll', onScroll)
    }
    scrollRoot.addEventListener('scroll', onScroll, { passive: true })

    function fire() {
      const entry = reader.entries.find((e) => e.id === entryId)
      if (
        shouldAutoRead({
          viewMode: reader.viewMode,
          userHasScrolled: reader.userHasScrolled,
          disabledAutoReadFeeds: feeds.disabledAutoReadFeeds,
          keepUnreadIds: [...reader.keepUnreadIds],
          feedId,
          entryId,
          status: entry?.status ?? 'read',
        })
      ) {
        reader.autoRead(entryId)
      }
    }

    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup = () => {
      observer.disconnect()
      scrollRoot.removeEventListener('scroll', onScroll)
    }
  },
  unmounted(el) {
    ;(el as HTMLElement & { __intersectLineCleanup?: () => void }).__intersectLineCleanup?.()
  },
}
