// Idle-time background refresh: keeps the sidebar honest while the page sits
// open (even when the user is fully idle) and re-checks the feed tail once
// scrolled to the end, so newly arrived items extend the current view instead
// of requiring a manual reload.

import { onMounted, onUnmounted } from 'vue'

import { useFeedsStore } from '@/client/stores/feeds'
import { useReaderStore } from '@/client/stores/reader'

const POLL_MS = 60_000
/** Full panel refresh (feeds + categories + counters) every Nth poll (~10 min). */
const PANEL_EVERY = 10

export function useIdleRefresh() {
  const feeds = useFeedsStore()
  const reader = useReaderStore()

  let timer: ReturnType<typeof setInterval> | null = null
  let tick = 0

  async function poll() {
    tick++
    // Store actions swallow their own errors; a failed poll must never throw.
    await feeds.refreshCounters()

    // Tail recheck goes direct to the source: counters only say *something*
    // changed; a page query past our loaded end says *what* extends the view.
    if (
      !reader.hasMore &&
      reader.atListEnd &&
      reader.entries.length > 0 &&
      !reader.filter.search
    ) {
      await reader.checkTail()
    }

    if (tick % PANEL_EVERY === 0) await feeds.refreshPanel()
  }

  onMounted(() => {
    timer = setInterval(() => void poll(), POLL_MS)
  })

  onUnmounted(() => {
    if (timer) clearInterval(timer)
  })
}
