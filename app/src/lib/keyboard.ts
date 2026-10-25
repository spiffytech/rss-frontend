/**
 * Global keyboard shortcuts — j/k/arrows move the reading anchor (and auto-read),
 * m toggles read, s stars, v toggles view mode, Shift+A marks the displayed set
 * read (explicit-ID semantics: exactly the IDs the view fetched).
 *
 * Returns a cleanup function; call it from `onCleanup` inside `onMount`.
 */
import type { EntryId } from '../shared/ids'
import type { Reader } from './reader'

export const attachKeyboard = (
  r: Reader,
  onToggleViewMode: () => void,
): (() => void) => {
  const currentEntry = (): { id: EntryId } | null => {
    if (!r.session.currentId) return null
    return r.entries().find((entry) => entry.id === r.session.currentId) ?? null
  }

  const onKeydown = (event: KeyboardEvent) => {
    // Don't hijack typing: bail when focus is inside a text/edit control.
    const target = event.target as HTMLElement | null
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return

    if (event.key === 'j' || event.key === 'ArrowDown') {
      event.preventDefault()
      r.moveAndRead(1)
    } else if (event.key === 'k' || event.key === 'ArrowUp') {
      event.preventDefault()
      r.moveAndRead(-1)
    } else if (event.key === 'm') {
      const current = currentEntry()
      if (current) r.toggleRead(current.id)
    } else if (event.key === 's') {
      const current = currentEntry()
      if (current) void r.toggleStar(current.id)
    } else if (event.key === 'v') {
      onToggleViewMode()
    } else if (event.key === 'A' && event.shiftKey) {
      event.preventDefault()
      r.markDisplayed()
    }
  }

  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}
