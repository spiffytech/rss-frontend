import type { FC } from 'hono/jsx'

import type { MinifluxEntry } from '../lib/types'
import EntryItem from './EntryItem'

interface EntryListProps {
  entries: MinifluxEntry[]
  viewMode: 'expanded' | 'list'
}

const EntryList: FC<EntryListProps> = ({ entries, viewMode }) => (
  <div data-testid="entry-list" class="flex flex-col gap-y-1 pb-[100dvh]">
    {entries.length === 0 ? (
      <p class="text-gray-500 text-sm px-2 py-4">No entries.</p>
    ) : (
      entries.map((entry) => (
        <EntryItem key={entry.id} entry={entry} viewMode={viewMode} />
      ))
    )}
    {/* Infinite-scroll sentinel: datastar's on-intersect-line plugin fires
        the GET when it scrolls into view. The 100dvh bottom padding on the
        list container ensures the last item can scroll all the way to the
        top of the scroll container. */}
    <div
      id="entry-sentinel"
      class="h-1 w-full"
      data-show="$hasMore && !$loadingMore"
      {...{ 'data-on-intersect': "$loadingMore = true; @get('/api/entries/more')" }}
    ></div>
  </div>
)

/** Fragment-only render (no #entry-list wrapper) for SSE append. */
export const EntryListFragment: FC<EntryListProps> = ({ entries, viewMode }) => (
  <>
    {entries.map((entry) => (
      <EntryItem key={entry.id} entry={entry} viewMode={viewMode} />
    ))}
    <div
      id="entry-sentinel"
      class="h-1 w-full"
      data-show="$hasMore && !$loadingMore"
      {...{ 'data-on-intersect': "$loadingMore = true; @get('/api/entries/more')" }}
    ></div>
  </>
)
export default EntryList