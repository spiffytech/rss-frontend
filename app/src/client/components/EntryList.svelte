<script lang="ts">
  // EntryList — the display window + end sentinel. Ported from the old
  // EntryList.vue (the 100dvh bottom padding lets the last item scroll all the
  // way to the top of the scroll container); the sentinel now pages the keyset
  // window instead of the old Miniflux cursor.
  import EntryItem from './EntryItem.svelte'
  import { loadMoreSentinel } from '../actions.js'
  import { appState, loadMore } from '../state.svelte.js'
</script>

<div data-testid="entry-list" class="flex flex-col gap-y-1 pb-[100dvh]">
  {#if appState.entries.length === 0}
    <p class="text-gray-500 text-sm px-2 py-4">No entries.</p>
  {/if}
  {#each appState.entries as entry (entry.id)}
    <EntryItem {entry} />
  {/each}
  <div id="entry-sentinel" class="h-1 w-full" class:hidden={appState.loadingMore} use:loadMoreSentinel={loadMore}></div>
</div>
