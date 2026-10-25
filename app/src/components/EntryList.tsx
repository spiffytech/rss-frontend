import { For, Show } from 'solid-js'

import { EntryItem } from './EntryItem'
import { observeSentinel } from '../lib/observers'
import { checkTail, loadMore, reader } from '../lib/state'

/**
 * The display window + end sentinel. The sentinel pages the keyset window; once
 * the window is exhausted it rechecks the tail for arrivals. The generous bottom
 * padding lets the last item scroll all the way to the top of the scroll
 * container (as the old EntryList did).
 */
export const EntryList = () => {
  // A fetch can be in flight when the sentinel reports again; the store guards
  // both paths with `loadingMore`.
  const onSentinel = (): Promise<void> => (reader.nextCursor ? loadMore() : checkTail())

  return (
    <div data-testid="entry-list" class="flex flex-col gap-y-1 pb-[100dvh]">
      <Show when={reader.entries.length === 0}>
        <p class="text-gray-500 text-sm px-2 py-4">No entries.</p>
      </Show>
      <For each={reader.entries}>{(entry) => <EntryItem entry={entry} />}</For>
      <div
        id="entry-sentinel"
        class={['h-1 w-full', { hidden: reader.loadingMore }]}
        ref={(element) => observeSentinel(element, onSentinel)}
      />
    </div>
  )
}

export default EntryList
