// useKeyboard — global keyboard shortcuts. Ported from the old datastar
// data-on:keydown__window handler: j/k/arrows move the reading anchor (and
// auto-read), m toggles read, s stars, v toggles view mode, Shift+A marks all
// read. Returns a cleanup function; call from onMounted.

import { onMounted, onUnmounted } from 'vue'
import { useReaderStore } from '@/client/stores/reader'

export function useKeyboard() {
  const reader = useReaderStore()

  function onKeydown(evt: KeyboardEvent) {
    if (evt.key === 'j' || evt.key === 'ArrowDown') {
      evt.preventDefault()
      const id = reader.move(1)
      if (id) reader.autoRead(id)
    } else if (evt.key === 'k' || evt.key === 'ArrowUp') {
      evt.preventDefault()
      const id = reader.move(-1)
      if (id) reader.autoRead(id)
    } else if (evt.key === 'm') {
      if (reader.currentId) reader.toggleRead(reader.currentId)
    } else if (evt.key === 's') {
      if (reader.currentId) reader.star(reader.currentId)
    } else if (evt.key === 'v') {
      reader.setViewMode(reader.viewMode === 'expanded' ? 'list' : 'expanded')
    } else if (evt.key === 'A' && evt.shiftKey) {
      reader.markAllRead()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeydown))
  onUnmounted(() => window.removeEventListener('keydown', onKeydown))
}
