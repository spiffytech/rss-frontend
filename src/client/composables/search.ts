// useSearch — the debounced entry search, shared by the toolbar's desktop box
// and the mobile feed popover's box. Both bind the same text and re-sync from
// the active filter, so the two boxes can never disagree about what is being
// searched (the feed popover is the only place mobile can see the query, and it
// is usually closed).

import { ref, watch } from 'vue'

import { useReaderStore } from '@/client/stores/reader'

const DEBOUNCE_MS = 300

export function useSearch() {
  const reader = useReaderStore()
  const searchText = ref(reader.filter.search ?? '')
  let timer: ReturnType<typeof setTimeout> | undefined

  // Navigating to another feed clears the filter's search (see the route
  // watcher in ReaderView), so the box has to clear with it.
  watch(
    () => reader.filter.search,
    (s) => {
      searchText.value = s ?? ''
    },
  )

  /** Push the current text into the filter once typing pauses. */
  function onSearchInput() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      reader.setFilter({ ...reader.filter, search: searchText.value || undefined })
      // Entries + counters only — not the full bootstrap (prefs/panel refetch)
      // which the debounce would otherwise fire on every search keystroke.
      reader.reloadView()
    }, DEBOUNCE_MS)
  }

  /** Drop the search immediately (the popover's "Clear search" row). */
  function clearSearch() {
    clearTimeout(timer)
    searchText.value = ''
    reader.setFilter({ ...reader.filter, search: undefined })
    reader.reloadView()
  }

  return { searchText, onSearchInput, clearSearch }
}