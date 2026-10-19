<script lang="ts">
  // EntryItem — one entry card. Structure and classes ported verbatim from the
  // old EntryItem.vue; the body's lazy `lazyHtml`/v-html is replaced by the
  // display pipeline (transform → sanitizer sink — never { @html }, see the
  // repo AGENTS.md rule). List-view expansion animates height by hand like the
  // old `<Transition :css="false">` did.
  import { trackTop, sweepLine } from '../actions.js'
  import { api } from '../api.js'
  import { appState, autoRead, effectiveViewMode, toggleExpanded, toggleRead, toggleStar } from '../state.svelte.js'
  import { sinkEntryContent, transformEntryContent } from '../display/render.js'
  import { timeAgo } from '../../shared/util.js'
  import type { EntrySummary } from '../../shared/types'

  let { entry }: { entry: EntrySummary } = $props()

  const unread = $derived(entry.status === 'unread')
  const viewMode = $derived(effectiveViewMode())
  const isExpandedView = $derived(viewMode === 'expanded')
  const showContent = $derived(isExpandedView || appState.expandedIds.includes(entry.id))

  let contentEl: HTMLDivElement | undefined = $state()
  let mounted = $state(false)
  let loaded = false
  let collapsing = false

  $effect(() => {
    if (showContent && !mounted) mounted = true
  })

  $effect(() => {
    if (!mounted || !contentEl || loaded) return
    loaded = true
    // Entry bodies are untrusted feed HTML: transform, then sink through the
    // safe sanitizer. Never {@html} (repo AGENTS.md rule).
    void api
      .content(entry.id)
      .then((c) => {
        sinkEntryContent(
          contentEl!,
          transformEntryContent(
            c.content,
            c.feedBaseUrl ?? entry.url ?? 'https://invalid.invalid/',
            entry.url,
          ),
        )
        // List-view expansion animates once the body is real (old app animated
        // the mounted body; ours loads lazily, so animate on arrival).
        if (!isExpandedView) animateHeight(contentEl!, 0, 'auto', () => {})
      })
      .catch(() => {
        if (contentEl) contentEl.textContent = 'Failed to load content.'
      })
  })

  // Collapse animates out, then unmounts (collapsed cards never keep bodies).
  $effect(() => {
    if (showContent || !mounted || collapsing) return
    if (isExpandedView || !contentEl) {
      mounted = false
      return
    }
    collapsing = true
    animateHeight(contentEl, 'auto', 0, () => {
      collapsing = false
      mounted = false
    })
  })

  const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const DURATION = 150

  function animateHeight(el: Element, from: number | 'auto', to: number | 'auto', done: () => void): void {
    const node = el as HTMLElement
    const settle = () => {
      node.style.transition = ''
      node.style.overflow = ''
      node.style.height = to === 'auto' ? '' : `${to}px`
    }
    if (reduceMotion()) {
      settle()
      done()
      return
    }
    let finished = false
    const finish = () => {
      if (finished) return
      finished = true
      node.removeEventListener('transitionend', onEnd)
      settle()
      done()
    }
    const onEnd = (e: TransitionEvent) => {
      if (e.target === node && e.propertyName === 'height') finish()
    }
    const start = from === 'auto' ? node.scrollHeight : from
    node.style.overflow = 'hidden'
    node.style.height = `${start}px`
    void node.offsetHeight
    node.style.transition = `height ${DURATION}ms ease`
    node.style.height = to === 'auto' ? `${node.scrollHeight}px` : `${to}px`
    node.addEventListener('transitionend', onEnd)
    window.setTimeout(finish, DURATION + 50)
  }

  function onCardClick(e: MouseEvent) {
    const el = e.target as HTMLElement
    // Star / keep-unread buttons have their own semantics — don't double-fire.
    if (el.closest('button')) return
    // Links open normally; clicks inside an expanded body don't fold it.
    if (!el.closest('a') && !el.closest('.reading')) {
      toggleExpanded(entry.id)
      return
    }
    // Clicking an entry is explicit: mark read even when mark-read-on-scroll
    // is disabled for the feed, and even in list view (autoRead owns the
    // keep-unread/search guards).
    autoRead(entry.id, false, { ignoreFeedSetting: true, explicit: true })
  }
</script>

<article
  id={`entry-${entry.id}`}
  data-entry-id={entry.id}
  use:trackTop={entry.id}
  use:sweepLine={{ entryId: entry.id, feedId: entry.feedId }}
  class="msgFrame px-3 py-2.5 border-b border-gray-200 {unread ? 'bg-white' : 'bg-gray-50'}"
  aria-expanded={showContent}
  onclick={onCardClick}
>
  <div class="msgButtons flex items-center gap-x-1 md:gap-x-2 text-xs">
    <a
      class="mtime text-gray-500 hover:text-gray-700 p-1.5 md:p-0 min-h-[28px] flex items-center"
      href={entry.url ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={new Date(entry.publishedAt).toISOString()}
    >
      {timeAgo(entry.publishedAt)}
    </a>
    <button
      type="button"
      class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
      title="Star (s)"
      onclick={() => toggleStar(entry.id)}
    >
      <span class={entry.starred ? 'text-yellow-500' : ''}>{entry.starred ? '★' : '☆'}</span>
    </button>
    <button
      type="button"
      class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
      title="Keep unread / mark read (m)"
      onclick={() => toggleRead(entry.id)}
    >
      ◉
    </button>
  </div>

  <div class="msgBody mt-1">
    <a
      class="msubject inline-block leading-snug font-semibold hover:underline text-lg break-words {unread
        ? 'text-gray-900'
        : 'text-gray-500'}"
      href={entry.url ?? undefined}
      target="_blank"
      rel="noreferrer"
    >
      {entry.title || '(untitled)'}
    </a>
    <div class="text-xs mt-1 {unread ? 'text-gray-500' : 'text-gray-400'}">
      from <span class={unread ? 'text-gray-700' : 'text-gray-500'}>{entry.feedTitle}</span>
      {#if entry.author && entry.author !== entry.feedTitle}
        · {entry.author}
      {/if}
    </div>

    {#if mounted}
      <div
        class="reading text-base mt-4 [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-500 [&_blockquote]:italic [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-4 [&_ul]:space-y-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-4 [&_ol]:space-y-1 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h4]:text-base [&_h5]:text-sm [&_h6]:text-xs [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:mt-4 [&_h3]:mb-1 [&_h4]:mt-3 [&_h4]:mb-1 [&_h5]:mt-3 [&_h5]:mb-1 [&_h6]:mt-3 [&_h6]:mb-1 [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em] [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm [&_th]:border [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-50 [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1 [&_figure]:my-4 [&_figcaption]:text-sm [&_figcaption]:text-gray-500 [&_figcaption]:mt-1"
        bind:this={contentEl}
      ></div>
    {/if}
  </div>
</article>
