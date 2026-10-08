<script setup lang="ts">
import { computed } from 'vue'

import { useReaderStore } from '@/client/stores/reader'
import { useMediaQuery } from '@/client/composables/media'
import { timeAgo, lazyHtml } from '@/shared/util'
import type { MinifluxEntry } from '@/shared/types'

const props = defineProps<{ entry: MinifluxEntry }>()
const reader = useReaderStore()

const unread = computed(() => props.entry.status === 'unread')
const isExpandedView = computed(() => reader.viewMode === 'expanded')
const showContent = computed(
  () => isExpandedView.value || reader.expandedIds.has(props.entry.id),
)

const contentHtml = computed(() => lazyHtml(props.entry.content))

// List-view expansion is animated by hand: <Transition :css="false"> means
// these hooks own the motion, so we can drive height from 0 ↔ scrollHeight and
// then clear the inline styles (letting v-html content reflow and respond to
// width changes). Content stays v-if-mounted, so collapsed entries never load
// their lazy images/iframes.
const reduceMotion = useMediaQuery('(prefers-reduced-motion: reduce)')
const DURATION = 150

function animateHeight(
  el: Element,
  from: number | 'auto',
  to: number | 'auto',
  done: () => void,
) {
  const node = el as HTMLElement
  const settle = () => {
    node.style.transition = ''
    node.style.overflow = ''
    // Enter settles at natural height; leave just needs any final value
    // (the element unmounts immediately after).
    node.style.height = to === 'auto' ? '' : `${to}px`
  }
  if (reduceMotion.value) {
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
  // Child transitions (hover effects) bubble too — only the height on this
  // node ends the enter/leave.
  const onEnd = (e: TransitionEvent) => {
    if (e.target === node && e.propertyName === 'height') finish()
  }
  const start = from === 'auto' ? node.scrollHeight : from
  node.style.overflow = 'hidden'
  node.style.height = `${start}px`
  // Force a reflow so the browser registers the start height before the
  // transition is enabled.
  void node.offsetHeight
  node.style.transition = `height ${DURATION}ms ease`
  node.style.height = to === 'auto' ? `${node.scrollHeight}px` : `${to}px`
  node.addEventListener('transitionend', onEnd)
  // transitionend can be dropped (interrupted or detached); never hang.
  window.setTimeout(finish, DURATION + 50)
}

// View-mode switches are not a user expand — no animation there.
function onEnter(el: Element, done: () => void) {
  if (isExpandedView.value) return done()
  animateHeight(el, 0, 'auto', done)
}

function onLeave(el: Element, done: () => void) {
  if (isExpandedView.value) return done()
  animateHeight(el, 'auto', 0, done)
}

function onCardClick(e: MouseEvent) {
  const el = e.target as HTMLElement
  // Star / keep-unread buttons have their own semantics — don't double-fire.
  if (el.closest('button')) return
  // Links (title, timestamp, in-content) open normally; don't toggle. Clicks
  // inside an expanded body shouldn't fold the item while it's being read.
  if (!el.closest('a') && !el.closest('.reading')) {
    reader.toggleExpanded(props.entry.id)
    return
  }
  // Clicking an entry is explicit: mark read even when mark-read-on-scroll
  // is disabled for the feed, and even in list view (autoRead still owns the
  // keep-unread/search guards).
  reader.autoRead(props.entry.id, false, { ignoreFeedSetting: true, explicit: true })
}
</script>

<template>
  <article
    :id="`entry-${entry.id}`"
    :data-entry-id="entry.id"
    v-track-top="entry.id"
    class="msgFrame px-3 py-2.5 border-b border-gray-200"
    :class="unread ? 'bg-white' : 'bg-gray-50'"
    :aria-expanded="showContent"
    v-intersect-line="{ entryId: entry.id, feedId: entry.feed_id }"
    @click="onCardClick"
  >
    <div class="msgButtons flex items-center gap-x-1 md:gap-x-2 text-xs">
      <a
        class="mtime text-gray-500 hover:text-gray-700 p-1.5 md:p-0 min-h-[28px] flex items-center"
        :href="entry.url"
        target="_blank"
        rel="noreferrer"
        :title="entry.published_at"
      >
        {{ timeAgo(entry.published_at) }}
      </a>
      <button
        type="button"
        class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
        title="Star (s)"
        @click="reader.star(entry.id)"
      >
        <span :class="entry.starred ? 'text-yellow-500' : ''">{{ entry.starred ? '★' : '☆' }}</span>
      </button>
      <button
        type="button"
        class="text-gray-500 hover:text-gray-700 p-2 -m-1 md:p-0 md:m-0 min-w-[28px] min-h-[28px]"
        title="Keep unread / mark read (m)"
        @click="reader.toggleRead(entry.id)"
      >
        ◉
      </button>
    </div>

    <div class="msgBody mt-1">
      <a
        class="msubject inline-block leading-snug font-semibold hover:underline text-lg break-words"
        :class="unread ? 'text-gray-900' : 'text-gray-500'"
        :href="entry.url"
        target="_blank"
        rel="noreferrer"
      >
        {{ entry.title || '(untitled)' }}
      </a>
      <div class="text-xs mt-1" :class="unread ? 'text-gray-500' : 'text-gray-400'">
        from <span :class="unread ? 'text-gray-700' : 'text-gray-500'">{{ entry.feed?.title ?? '' }}</span>
        <template v-if="entry.author && entry.author !== entry.feed?.title">
          · {{ entry.author }}
        </template>
      </div>

      <Transition :css="false" @enter="onEnter" @leave="onLeave">
        <div
          v-if="showContent"
          class="reading text-base mt-4
          [&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-gray-200 [&_blockquote]:pl-4 [&_blockquote]:text-gray-500 [&_blockquote]:italic
          [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-4 [&_ul]:space-y-1
          [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-4 [&_ol]:space-y-1
          [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h4]:text-base [&_h5]:text-sm [&_h6]:text-xs
          [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold
          [&_h1]:mt-6 [&_h1]:mb-3 [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:mt-4 [&_h3]:mb-1 [&_h4]:mt-3 [&_h4]:mb-1 [&_h5]:mt-3 [&_h5]:mb-1 [&_h6]:mt-3 [&_h6]:mb-1
          [&_code]:bg-gray-100 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[0.9em]
          [&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm
          [&_th]:border [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:bg-gray-50
          [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1
          [&_figure]:my-4 [&_figcaption]:text-sm [&_figcaption]:text-gray-500 [&_figcaption]:mt-1"
          v-html="contentHtml"
        />
      </Transition>
    </div>
  </article>
</template>
