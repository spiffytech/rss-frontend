import { ref, onMounted, onUnmounted } from 'vue'

/**
 * Reactive media-query match. Used to keep the sidebar visible on desktop
 * (md+) regardless of the mobile drawer state.
 */
export function useMediaQuery(query: string) {
  const matches = ref(false)
  let mql: MediaQueryList | null = null

  const onChange = () => {
    matches.value = mql?.matches ?? false
  }

  onMounted(() => {
    mql = window.matchMedia(query)
    onChange()
    mql.addEventListener('change', onChange)
  })

  onUnmounted(() => {
    mql?.removeEventListener('change', onChange)
  })

  return matches
}
