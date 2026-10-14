<script lang="ts">
  // App shell. The auth gate runs server-side in +layout.server.ts (redirects),
  // so unlike the old SPA's client-side `Loading…` gate there is nothing to
  // wait for here — routes render (and server-render) directly.
  import '../app.css'
  // The <lite-youtube> element's styles ship in a separate file (the package's
  // "style" field): importing the JS alone defines the element but leaves the
  // poster and play button unstyled.
  import 'lite-youtube-embed/src/lite-yt-embed.css'
  import { onMount } from 'svelte'

  let { children, data } = $props()

  onMount(() => {
    // <lite-youtube> elements are created by the display pipeline
    // (client/display/render.ts), but the element is only *defined* by importing
    // lite-youtube-embed. That module registers a custom element and so touches
    // `document` at import time: browser-only, hence here rather than in render.ts
    // (which is also loaded during SSR).
    void import('lite-youtube-embed')
    if (data.user) {
      void import('../client/state.svelte.js').then((m) => {
        m.appState.session = { authenticated: true, username: data.user.username }
      })
    }
  })
</script>

{@render children()}
