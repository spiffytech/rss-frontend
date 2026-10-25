/**
 * Global keyboard shortcuts — j/k/arrows move the reading anchor (and auto-read),
 * m toggles read, s stars, v toggles view mode, Shift+A marks the displayed set
 * read (explicit-ID semantics: exactly the IDs the view fetched).
 *
 * Returns a cleanup function; call it from `onCleanup` inside `onMount`.
 */
import { reader, markDisplayed, moveAndRead, toggleRead, toggleStar } from './state'
import type { EntryId } from '../shared/ids'

export const attachKeyboard = (onToggleViewMode: () => void): (() => void) => {
  const currentEntry = (): { id: EntryId } | null => {
    if (!reader.currentId) return null
    return reader.entries.find((entry) => entry.id === reader.currentId) ?? null
  }

  const onKeydown = (event: KeyboardEvent) => {
    // Don't hijack typing: bail when focus is inside a text/edit control.
    const target = event.target as HTMLElement | null
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveAndRead(1)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveAndRead(-1)
    } else if (event.key === 'm') {
      const current = currentEntry()
      if (current) toggleRead(current.id)
    } else if (event.key === 's') {
      const current = currentEntry()
      if (current) void toggleStar(current.id)
    } else if (event.key === 'v') {
      onToggleViewMode()
    } else if (event.key === 'A' && event.shiftKey) {
      event.preventDefault()
      markDisplayed()
    }
  }

  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}
