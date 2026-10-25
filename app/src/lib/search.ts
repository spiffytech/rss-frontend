/**
 * Debounced entry search, shared by the toolbar's desktop box and the mobile
 * feed popover's box. Both boxes sync from the active filter, so the two can
 * never disagree about what is being searched.
 */
import { createEffect, createSignal } from 'solid-js'

import { reader, reloadEntries, setFilter } from './state'

const DEBOUNCE_MS = 300

export const createSearch = () => {
  const [text, setText] = createSignal(reader.filter.search ?? '')
  let timer: ReturnType<typeof setTimeout> | undefined

  // Navigating to another view clears the filter's search — the box clears with it.
  createEffect(
    () => reader.filter.search,
    (search) => {
      clearTimeout(timer)
      setText(search ?? '')
    },
  )

  /** Push the current text into the filter once typing pauses. */
  const onSearchInput = (value: string): void => {
    setText(value)
    clearTimeout(timer)
    timer = setTimeout(() => {
      setFilter({ ...reader.filter, search: value || undefined })
      // Entries + counters only — not the full bootstrap (prefs/panel refetch)
      // which the debounce would otherwise fire on every search keystroke.
      void reloadEntries(reader.filter)
    }, DEBOUNCE_MS)
  }

  /** Drop the search immediately (the popover's "Clear search" row). */
  const clearSearch = (): void => {
    clearTimeout(timer)
    setText('')
    setFilter({ ...reader.filter, search: undefined })
    void reloadEntries(reader.filter)
  }

  return { text, onSearchInput, clearSearch }
}
