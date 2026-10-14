<script lang="ts">
  // EntryList — the display window + end sentinel. Ported from the old
  // EntryList.vue (the 100dvh bottom padding lets the last item scroll all the
  // way to the top of the scroll container); the sentinel now pages the keyset
  // window instead of the old Miniflux cursor.
  import EntryItem from './EntryItem.svelte'
  import { loadMoreSentinel } from '../actions.js'
  import { appState, checkTail, loadMore } from '../state.svelte.js'

  // The sentinel pages the keyset window; once the window is exhausted it
  // rechecks the tail for arrivals (old EntryList/checkTail semantics).
  const onSentinel = (): Promise<void> => (appState.nextCursor ? loadMore() : checkTail())
</script>

<div data-testid="entry-list" class="flex flex-col gap-y-1 pb-[100dvh]">
  {#if appState.entries.length === 0}
    <p class="text-gray-500 text-sm px-2 py-4">No entries.</p>
  {/if}
  {#each appState.entries as entry (entry.id)}
    <EntryItem {entry} />
  {/each}
  <div id="entry-sentinel" class="h-1 w-full" class:hidden={appState.loadingMore} use:loadMoreSentinel={onSentinel}></div>
</div>
