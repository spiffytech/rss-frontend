<script lang="ts">
  // FeedIcon — the feed's icon with a letter fallback when the <img> errors.
  // Ported from the old FeedIcon.vue.
  import { markIconFailed, appState } from '../state.svelte.js'
  import type { FeedId } from '../../shared/ids'

  let { feedId, title }: { feedId: FeedId; title: string } = $props()
</script>

<span class="inline-flex items-center shrink-0 relative w-5 h-5" aria-hidden="true">
  <img
    src={`/api/icons/${feedId}`}
    alt=""
    class="w-5 h-5 rounded-sm"
    loading="lazy"
    class:hidden={appState.iconFailed[feedId] === true}
    onerror={() => markIconFailed(feedId)}
  />
  {#if appState.iconFailed[feedId] === true}
    <span class="absolute inset-0 inline-flex items-center justify-center rounded-sm bg-gray-200 text-gray-600 text-xs font-semibold">
      {(title.trim()[0] ?? '?').toUpperCase()}
    </span>
  {/if}
</span>
