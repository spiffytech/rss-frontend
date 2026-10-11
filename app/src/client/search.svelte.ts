// Debounced entry search, shared by the toolbar's desktop box and the mobile
// feed popover's box. Both bind the same text and re-sync from the active
// filter, so the two boxes can never disagree about what is being searched.
// (Port of the old useSearch composable.)
import { appState, reloadEntries, setFilter } from './state.svelte.js'

const DEBOUNCE_MS = 300

export function createSearch() {
  let text = $state(appState.filter.search ?? '')
  let timer: ReturnType<typeof setTimeout> | undefined

  // Navigating to another view clears the filter's search — the box clears with it.
  $effect(() => {
    text = appState.filter.search ?? ''
  })

  /** Push the current text into the filter once typing pauses. */
  function onSearchInput() {
    clearTimeout(timer)
    timer = setTimeout(() => {
      setFilter({ ...appState.filter, search: text || undefined })
      // Entries + counters only — not the full bootstrap (prefs/panel refetch)
      // which the debounce would otherwise fire on every search keystroke.
      void reloadEntries(appState.filter)
    }, DEBOUNCE_MS)
  }

  /** Drop the search immediately (the popover's "Clear search" row). */
  function clearSearch() {
    clearTimeout(timer)
    text = ''
    setFilter({ ...appState.filter, search: undefined })
    void reloadEntries(appState.filter)
  }

  return {
    get searchText() {
      return text
    },
    set searchText(v: string) {
      text = v
    },
    onSearchInput,
    clearSearch,
  }
}
