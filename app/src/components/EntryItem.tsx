import { Show, createEffect, createSignal } from 'solid-js'

import type { EntrySummary } from '../shared/types'
import { timeAgo } from '../shared/util'
import { trackEntry } from '../lib/observers'
import { sinkEntryContent, transformEntryContent } from '../lib/display/render'
import * as api from '../server/actions'
import {
  autoRead,
  effectiveViewMode,
  reader,
  toggleExpanded,
  toggleRead,
  toggleStar,
} from '../lib/state'

/**
 * One entry card. Structure and classes come verbatim from the pre-port reader;
 * the body is rendered through the display pipeline (transform → sanitizer sink)
 * — never as raw HTML, because entry content is untrusted feed HTML and a server
 * render of it would be an unguarded sink.
 *
 * List-view expansion animates height by hand, as the old `<Transition :css>`
 * did: bodies load lazily, so the animation runs when the body arrives, not when
 * the row expands.
 */
export const EntryItem = (props: { entry: EntrySummary }) => {
  const unread = () => props.entry.status === 'unread'
  const isExpandedView = () => effectiveViewMode() === 'expanded'
  const showContent = () =>
    isExpandedView() || reader.expandedIds.includes(props.entry.id)

  const [mounted, setMounted] = createSignal(false)
  let contentEl: HTMLDivElement | undefined
  let loaded = false
  let collapsing = false

  createEffect(
    () => showContent(),
    (show) => {
      if (show) {
        setMounted(true)
        return
      }
      // Collapse animates out, then unmounts (collapsed cards never keep bodies).
      if (!mounted() || collapsing) return
      if (isExpandedView() || !contentEl) {
        setMounted(false)
        return
      }
      collapsing = true
      animateHeight(contentEl, 'auto', 0, () => {
        collapsing = false
        setMounted(false)
      })
    },
  )

  /**
   * Fetch and sink the body, once.
   *
   * Called from the container's ref rather than an effect on `mounted()`: the
   * ref is the only moment the element is known to exist, and an effect keyed on
   * the signal can run before the <Show> that creates it has rendered.
   */
  const loadBody = (element: HTMLDivElement): void => {
    contentEl = element
    if (loaded) return
    loaded = true
    const entry = props.entry
    api
      .content(entry.id)
      .then((payload) => {
        sinkEntryContent(
          element,
          transformEntryContent(
            payload.content,
            payload.feedBaseUrl ?? entry.url ?? 'https://invalid.invalid/',
            entry.url,
          ),
        )
        // List-view expansion animates once the body is real (the old app
        // animated the mounted body; ours loads lazily, so animate on arrival).
        if (!isExpandedView()) animateHeight(element, 0, 'auto', () => {})
      })
      .catch(() => {
        element.textContent = 'Failed to load content.'
      })
  }

  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const DURATION = 150

  const animateHeight = (
    element: HTMLElement,
    from: number | 'auto',
    to: number | 'auto',
    done: () => void,
  ): void => {
    const settle = () => {
      element.style.transition = ''
      element.style.overflow = ''
      element.style.height = to === 'auto' ? '' : `${to}px`
    }
    if (reduceMotion()) {
      settle()
      done()
      return
    }
    let finished = false
    const onEnd = (event: TransitionEvent) => {
      if (event.target === element && event.propertyName === 'height') finish()
    }
    const finish = () => {
      if (finished) return
      finished = true
      element.removeEventListener('transitionend', onEnd)
      settle()
      done()
    }
    const start = from === 'auto' ? element.scrollHeight : from
    element.style.overflow = 'hidden'
    element.style.height = `${start}px`
    void element.offsetHeight
    element.style.transition = `height ${DURATION}ms ease`
    element.style.height = to === 'auto' ? `${element.scrollHeight}px` : `${to}px`
    element.addEventListener('transitionend', onEnd)
    window.setTimeout(finish, DURATION + 50)
  }

  const onCardClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    // Star / keep-unread buttons have their own semantics — don't double-fire.
    if (target.closest('button')) return
    // Links open normally; clicks inside an expanded body don't fold it.
    if (!target.closest('a') && !target.closest('.reading')) {
      toggleExpanded(props.entry.id)
      return
    }
    // Clicking an entry is explicit: mark read even when mark-read-on-scroll is
    // disabled for the feed, and even in list view (autoRead owns the
    // keep-unread/search guards).
    autoRead(props.entry.id, false, { ignoreFeedSetting: true, explicit: true })
  }

  return (
    <article
      id={`entry-${props.entry.id}`}
      data-entry-id={props.entry.id}
      ref={(element) => trackEntry(element, props.entry.id)}
      class={[
        'msgFrame px-3 py-2.5 border-b border-gray-200',
        unread() ? 'bg-white' : 'bg-gray-50',
      ]}
      aria-expanded={showContent() ? 'true' : 'false'}
      onClick={onCardClick}
    >
      <div class="msgButtons flex items-center gap-x-1 md:gap-x-2 text-xs">
        <a
          class="mtime text-gray-500 hover:text-gray-700 p-1.5 md:p-0 min-h-[28px] flex items-center"
          href={props.entry.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={new Date(props.entry.publishedAt).toISOString()}
        >
          {timeAgo(props.entry.publishedAt)}
        </a>
        <button
          type="button"
          class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
          title="Star (s)"
          onClick={() => void toggleStar(props.entry.id)}
        >
          <span class={props.entry.starred ? 'text-yellow-500' : ''}>
            {props.entry.starred ? '★' : '☆'}
          </span>
        </button>
        <button
          type="button"
          class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
          title="Keep unread / mark read (m)"
          onClick={() => toggleRead(props.entry.id)}
        >
          ◉
        </button>
      </div>

      <div class="msgBody mt-1">
        <a
          class={[
            'msubject inline-block leading-snug font-semibold hover:underline text-lg break-words',
            unread() ? 'text-gray-900' : 'text-gray-500',
          ]}
          href={props.entry.url ?? undefined}
          target="_blank"
          rel="noreferrer"
        >
          {props.entry.title || '(untitled)'}
        </a>
        <div class={['text-xs mt-1', unread() ? 'text-gray-500' : 'text-gray-400']}>
          from{' '}
          <span class={unread() ? 'text-gray-700' : 'text-gray-500'}>
            {props.entry.feedTitle}
          </span>
          <Show when={props.entry.author && props.entry.author !== props.entry.feedTitle}>
            {' · '}
            {props.entry.author}
          </Show>
        </div>

        <Show when={mounted()}>
          <div
            ref={(element) => loadBody(element)}
            class="reading text-base mt-4 [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-500 [&_blockquote]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-4 [&_ol]:space-y-1 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h4]:text-base [&_h5]:text-sm [&_h6]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:mt-4 [&_h3]:mb-1 [&_h4]:mt-3 [&_h4]:mb-1 [&_h5]:mt-3 [&_h5]:mb-1 [&_h6]:mt-3 [&_h6]:mb-1 [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em] [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm [&_th]:border [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-50 [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1 [&_figure]:my-4 [&_figcaption]:text-sm [&_figcaption]:text-gray-500 [&_figcaption]:mt-1"
          />
        </Show>
      </div>
    </article>
  )
}

export default EntryItem
