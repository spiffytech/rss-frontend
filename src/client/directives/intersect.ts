// v-intersect directive — infinite-scroll sentinel. Ported from the old
// datastar on-intersect plugin: fires on EVERY intersection including the
// initial mount report, so an under-filled viewport immediately fetches more
// pages. Uses a generous rootMargin so it fires before the sentinel reaches
// the exact bottom. The reader store guards with hasMore && !loadingMore.

import type { Directive } from 'vue'
import { useReaderStore } from '@/client/stores/reader'

function getScrollRoot(el: Element): Element {
  return el.closest('[data-testid="entry-list"]')?.parentElement ?? document.body
}

export const vIntersect: Directive<HTMLElement, unknown> = {
  mounted(el) {
    const reader = useReaderStore()
    const scrollRoot = getScrollRoot(el)
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            reader.loadEnd()
          }
        }
      },
      {
        root: scrollRoot,
        rootMargin: '0px 0px 400px 0px',
        threshold: 0,
      },
    )
    observer.observe(el)
    ;(el as HTMLElement & { __intersectCleanup?: () => void }).__intersectCleanup = () => {
      observer.disconnect()
    }
  },
  unmounted(el) {
    ;(el as HTMLElement & { __intersectCleanup?: () => void }).__intersectCleanup?.()
  },
}
