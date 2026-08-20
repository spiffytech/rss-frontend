import type { FC } from 'hono/jsx'

import type { MinifluxEntry } from '../lib/types'
import { lazyHtml } from '../lib/miniflux'
import { timeAgo } from '../lib/util'

interface EntryItemProps {
  entry: MinifluxEntry
  viewMode: 'expanded' | 'list'
}

const EntryItem: FC<EntryItemProps> = ({ entry, viewMode }) => {
  const id = entry.id
  const unread = entry.status === 'unread'
  const isExpandedView = viewMode === 'expanded'
  const showContent = isExpandedView

  return (
    <article
      id={`entry-${id}`}
      data-entry-id={id}
      data-track-top={id}
      class={`msgFrame px-3 py-2.5 border-b border-gray-200 ${
        unread ? 'bg-white' : 'bg-gray-50'
      }`}
      {...{
        'data-on-intersect-line':
          unread && isExpandedView
            ? `$userHasScrolled && !$disabledAutoReadFeeds.includes(${entry.feed_id}) && !$keepUnreadIds.includes(${id}) && @post('/api/entries/${id}/auto-read')`
            : undefined,
      }}
    >
      <div class="msgButtons flex items-center gap-x-1 md:gap-x-2 text-xs">
        <a
          class="mtime text-gray-500 hover:text-gray-700 p-1.5 md:p-0 min-h-[28px] flex items-center"
          href={entry.url}
          target="_blank"
          rel="noreferrer"
          title={entry.published_at}
        >
          {timeAgo(entry.published_at)}
        </a>
        <button
          type="button"
          class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
          title="Star (s)"
          data-on:click={`@post('/api/entries/${id}/star')`}
        >
          <span class={entry.starred ? 'text-yellow-500' : ''}>{entry.starred ? '★' : '☆'}</span>
        </button>
        <button
          type="button"
          class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
          title="Keep unread / mark read (m)"
          data-on:click={`@post('/api/entries/${id}/toggle-read')`}
        >
          ◉
        </button>
      </div>

      <div class="msgBody mt-1">
        <a
          class={`msubject block leading-snug font-semibold hover:underline text-lg break-words ${
            unread ? 'text-gray-900' : 'text-gray-500'
          }`}
          href={entry.url}
          target="_blank"
          rel="noreferrer"
        >
          {entry.title || '(untitled)'}
        </a>
        <div class={`text-xs mt-1 ${unread ? 'text-gray-500' : 'text-gray-400'}`}>
          from <span class={unread ? 'text-gray-700' : 'text-gray-500'}>{entry.feed?.title ?? ''}</span>
          {entry.author && entry.author !== entry.feed?.title ? ` · ${entry.author}` : ''}
        </div>

        {showContent && (
          <div
            class="reading text-base mt-4
              [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-500 [&_blockquote]:italic
              [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-4 [&_ul]:space-y-1
              [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-4 [&_ol]:space-y-1
              [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h4]:text-base [&_h5]:text-sm [&_h6]:text-xs
              [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold
              [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:mt-4 [&_h3]:mb-2 [&_h4]:mt-3 [&_h4]:mb-1 [&_h5]:mt-3 [&_h5]:mb-1 [&_h6]:mt-3 [&_h6]:mb-1
              [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em]
              [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm
              [&_th]:border [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-50
              [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1
              [&_figure]:my-4 [&_figcaption]:text-sm [&_figcaption]:text-gray-500 [&_figcaption]:mt-1"
            dangerouslySetInnerHTML={{ __html: lazyHtml(entry.content) }}
          />
        )}
      </div>
    </article>
  )
}

export default EntryItem