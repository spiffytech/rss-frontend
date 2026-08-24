// useSidebarResize — desktop drag-to-resize of the sidebar. Ported from the
// old vanilla JS in Layout.tsx: pure pointer events + a CSS var (--sidebar-w)
// that the grid column reads. Deferred until the handle exists in the DOM.

import { onMounted, onUnmounted } from 'vue'

const MIN = 200
const MAX = 480
const STORAGE_KEY = 'mf-sidebar-w'

function clamp(v: number): number {
  return Math.min(MAX, Math.max(MIN, v))
}

export function useSidebarResize() {
  let handle: HTMLElement | null = null
  let startX = 0
  let startW = 280

  function setW(w: number) {
    document.documentElement.style.setProperty('--sidebar-w', `${clamp(w)}px`)
  }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault()
    startX = e.clientX
    startW =
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
      ) || 280
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const move = (ev: PointerEvent) => setW(startW + (ev.clientX - startX))
    const up = () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', up)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        localStorage.setItem(
          STORAGE_KEY,
          getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'),
        )
      } catch {
        // ignore
      }
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', up)
  }

  onMounted(() => {
    handle = document.getElementById('sidebar-resize')
    if (!handle) return
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const n = parseInt(saved, 10)
        if (n > 0) setW(n)
      }
    } catch {
      // ignore
    }
    handle.addEventListener('pointerdown', onPointerDown)
  })

  onUnmounted(() => {
    handle?.removeEventListener('pointerdown', onPointerDown)
  })
}
