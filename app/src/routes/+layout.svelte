<script lang="ts">
  // App shell. The auth gate runs server-side in +layout.server.ts (redirects),
  // so unlike the old SPA's client-side `Loading…` gate there is nothing to
  // wait for here — routes render (and server-render) directly.
  import '../app.css'
  import { onMount } from 'svelte'

  let { children, data } = $props()

  onMount(() => {
    if (data.user) {
      void import('../client/state.svelte.js').then((m) => {
        m.appState.session = { authenticated: true, username: data.user.username }
      })
    }
  })
</script>

{@render children()}
