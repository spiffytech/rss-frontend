/**
 * Global keyboard shortcuts — port of the old datastar keydown handler:
 * j/k/arrows move the reading anchor (and auto-read), m toggles read,
 * s stars, v toggles view mode, Shift+A marks the displayed set read
 * (explicit-ID semantics: exactly the IDs the view fetched).
 * Returns a cleanup function; call from onMount.
 */
import type { EntryId } from '../shared/ids'
import { appState, moveAndRead, markDisplayed, toggleRead, toggleStar } from './state.svelte'

export function attachKeyboard(onToggleViewMode: () => void): () => void {
  function onKeydown(evt: KeyboardEvent) {
    // Don't hijack typing: bail when focus is inside a text/edit control.
    const target = evt.target as HTMLElement | null
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) return

    if (evt.key === 'j' || evt.key === 'ArrowDown') {
      evt.preventDefault()
      moveAndRead(1)
    } else if (evt.key === 'k' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      moveAndRead(-1)
    } else if (evt.key === 'm') {
      const current = currentEntry()
      if (current) toggleRead(current.id)
    } else if (evt.key === 's') {
      const current = currentEntry()
      if (current) toggleStar(current.id)
    } else if (evt.key === 'v') {
      onToggleViewMode()
    } else if (evt.key === 'A' && evt.shiftKey) {
      evt.preventDefault()
      markDisplayed()
    }
  }

  window.addEventListener('keydown', onKeydown)
  return () => window.removeEventListener('keydown', onKeydown)
}

function currentEntry(): { id: EntryId } | null {
  if (!appState.currentId) return null
  return appState.entries.find((e) => e.id === appState.currentId) ?? null
}
