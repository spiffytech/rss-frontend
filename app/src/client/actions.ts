/**
 * Svelte actions porting the old Vue directives:
 * - `trackTop` (v-track-top): one shared IntersectionObserver per scroll
 *   root; records rects and picks the topmost visible entry as the reading
 *   anchor (pickTopmostVisible). First batch only records geometry — the
 *   list loads unselected, like a fresh page load.
 * - `sweepLine` (v-intersect-line): a pure state sweep on scroll — entries
 *   whose top edge crosses the band line (15% from the root's top) fire
 *   autoRead once (isScrolledPast), gated on userHasScrolled.
 * - `loadMoreSentinel` (v-intersect): pages the keyset window; when the
 *   window is exhausted the store rechecks the tail instead (checkTail).
 */
import type { Action } from 'svelte/action'

import { isScrolledPast, pickTopmostVisible, type TrackedRect } from '../shared/reading'
import type { EntryId, FeedId } from '../shared/ids'
import { appState, autoRead } from './state.svelte.js'

const BAND_FRACTION = 0.15

type Member = { el: HTMLElement; entryId: EntryId; feedId: FeedId }

type RootState = {
  observer: IntersectionObserver
  registry: Map<EntryId, TrackedRect>
  members: Set<Member>
  initialized: boolean
  pageGen: number
  rafId: number | null
  onScroll: () => void
  refCount: number
}

const byRoot = new WeakMap<Element, RootState>()

function rootOf(el: Element): Element {
  return el.closest('[data-testid="entry-list"]')?.parentElement ?? document.body
}

function scheduleSweep(root: Element, state: RootState): void {
  if (state.rafId != null) return
  state.rafId = requestAnimationFrame(() => {
    state.rafId = null
    // autoRead owns the full guard; this is just the cheapest pre-check.
    if (!appState.userHasScrolled) return
    const rootRect = root.getBoundingClientRect()
    const bandY = rootRect.top + rootRect.height * BAND_FRACTION
    for (const member of [...state.members]) {
      if (!member.el.isConnected) {
        state.members.delete(member)
      } else if (isScrolledPast(member.el.getBoundingClientRect(), bandY)) {
        state.members.delete(member)
        autoRead(member.entryId, true) // viaScroll: requires userHasScrolled
      }
    }
  })
}

function ensureRoot(root: Element): RootState {
  let state = byRoot.get(root)
  if (state) return state

  const registry = new Map<EntryId, TrackedRect>()
  const members = new Set<Member>()
  const observer = new IntersectionObserver(
    (batch) => {
      const st = byRoot.get(root)
      if (!st) return
      for (const item of batch) {
        if (!item.rootBounds) continue
        const id = item.target.getAttribute('data-track-top')
        if (!id) continue
        registry.set(id as EntryId, {
          top: item.boundingClientRect.top - item.rootBounds.top,
          bottom: item.boundingClientRect.bottom - item.rootBounds.top,
        })
      }
      if (!st.initialized) {
        // First batch after (re)load records geometry only: the list starts
        // unselected so navigating to a feed never inherits the last anchor.
        st.initialized = true
        return
      }
      const best = pickTopmostVisible(registry)
      if (best != null) appState.currentId = best
    },
    { root, rootMargin: '0px 0px -95% 0px', threshold: 0 },
  )

  const onScroll = () => {
    // A scroll landing at scrollTop 0 is our own programmatic reset.
    if (root.scrollTop !== 0) appState.userHasScrolled = true
    scheduleSweep(root, state!)
  }
  root.addEventListener('scroll', onScroll, { passive: true })

  state = {
    observer,
    registry,
    members,
    initialized: false,
    pageGen: appState.pageGen,
    rafId: null,
    onScroll,
    refCount: 0,
  }
  byRoot.set(root, state)
  return state
}

function releaseRoot(root: Element, state: RootState): void {
  state.refCount--
  if (state.refCount > 0) return
  root.removeEventListener('scroll', state.onScroll)
  state.observer.disconnect()
  byRoot.delete(root)
}

export const trackTop: Action<HTMLElement, EntryId> = (node, entryId) => {
  const root = rootOf(node)
  const state = ensureRoot(root)
  state.refCount++
  // A new list replaced the old one: re-arm the init guard so the fresh list
  // starts unselected (currentId stays null until scroll or j).
  if (state.pageGen !== appState.pageGen) {
    state.pageGen = appState.pageGen
    state.initialized = false
    state.registry.clear()
    state.members.clear()
  }
  node.setAttribute('data-track-top', entryId)
  state.observer.observe(node)

  return {
    update(next: EntryId) {
      state.registry.delete(entryId)
      node.setAttribute('data-track-top', next)
      entryId = next
    },
    destroy() {
      state.registry.delete(entryId)
      state.observer.unobserve(node)
      releaseRoot(root, state)
    },
  }
}

export const sweepLine: Action<HTMLElement, { entryId: EntryId; feedId: FeedId }> = (node, value) => {
  const root = rootOf(node)
  const state = ensureRoot(root)
  state.refCount++
  const member: Member = { el: node, entryId: value.entryId, feedId: value.feedId }
  state.members.add(member)

  return {
    update(next: { entryId: EntryId; feedId: FeedId }) {
      member.entryId = next.entryId
      member.feedId = next.feedId
    },
    destroy() {
      state.members.delete(member)
      releaseRoot(root, state)
    },
  }
}

/**
 * Scroll sentinel for windowed views (port of the old v-intersect): fires on
 * every intersection including the initial mount report, so an under-filled
 * viewport immediately pulls the next window. The store guards with
 * `nextCursor && !loadingMore`.
 */
export const loadMoreSentinel: Action<HTMLElement, () => Promise<void>> = (node, loadMore) => {
  let fire = loadMore
  const root = node.closest('[data-testid="entry-list"]')?.parentElement ?? null
  const observer = new IntersectionObserver(
    (batch) => {
      for (const item of batch) if (item.isIntersecting) void fire()
    },
    { root, rootMargin: '0px 0px 400px 0px', threshold: 0 },
  )
  observer.observe(node)
  return {
    update(next: () => Promise<void>) {
      fire = next
    },
    destroy() {
      observer.disconnect()
    },
  }
}

/** Focus an element the moment it mounts (`use:autofocus`) — rename editors. */
export function autofocus(node: HTMLElement): void {
  node.focus()
}
