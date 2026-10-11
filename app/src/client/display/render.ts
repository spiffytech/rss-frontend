/**
 * Display pipeline (client-only): raw feed HTML → transformed string → safe
 * sink. The Sanitizer API is DOM-time only, so this module runs in the
 * browser; entry content is NEVER server-rendered through `{@html}` (repo
 * AGENTS.md rule).
 *
 * transformEntryContent(): inert parse (`Document.parseHTMLUnsafe`, the tree
 * is never inserted) → DOM walk (YouTube → <lite-youtube>, relative URLs
 * resolved against the feed base, `<base>` dropped) → serialized string.
 *
 * sinkEntryContent(): `Element.setHTML()` with the shared policy; on Safari
 * (Sanitizer API not shipped) DOMPurify compiled from the SAME policy table.
 */
import DOMPurify from 'dompurify'

import { POLICY, safeUrlProtocol, toDomPurifyConfig, toSanitizerConfig } from './policy'
import { parseYouTubeUrl } from './youtube'

const URL_ATTRS: Array<[string, string]> = [
  ['a', 'href'],
  ['img', 'src'],
  ['video', 'src'],
  ['video', 'poster'],
  ['audio', 'src'],
  ['source', 'srcset'],
  ['blockquote', 'cite'],
]

function resolveOrDrop(element: Element, attr: string, feedBaseUrl: string): void {
  const raw = element.getAttribute(attr)
  if (raw === null) return
  const trimmed = raw.trim()
  if (trimmed === '') {
    element.removeAttribute(attr)
    return
  }
  if (attr === 'srcset') {
    // Keep the candidate list, resolve each URL; drop unsafe candidates.
    const resolved = trimmed
      .split(',')
      .map((candidate) => {
        const parts = candidate.trim().split(/\s+/)
        const url = resolveUrl(parts[0] ?? '', feedBaseUrl)
        return safeUrlProtocol(url) ? [url, ...parts.slice(1)].join(' ') : null
      })
      .filter((c): c is string => c !== null)
    if (resolved.length === 0) element.removeAttribute(attr)
    else element.setAttribute(attr, resolved.join(', '))
    return
  }
  // Resolve first (relative URLs are only meaningful against the feed base),
  // THEN gate the absolute result's protocol.
  const resolved = resolveUrl(trimmed, feedBaseUrl)
  if (!safeUrlProtocol(resolved)) {
    element.removeAttribute(attr)
    return
  }
  element.setAttribute(attr, resolved)
}

function resolveUrl(raw: string, feedBaseUrl: string): string {
  if (raw.startsWith('#')) return raw
  try {
    return new URL(raw, feedBaseUrl).toString()
  } catch {
    return raw
  }
}

function walk(node: Element, feedBaseUrl: string): Element | null {
  // <base> in entry markup re-targets every relative URL — drop it outright.
  if (node.tagName.toLowerCase() === 'base') return null

  // YouTube embeds → lite-youtube custom element (allowed by the policy).
  if (node.tagName.toLowerCase() === 'iframe') {
    const src = node.getAttribute('src') ?? ''
    const youtube = parseYouTubeUrl(src)
    if (!youtube) return null // only lite-youtube embeds survive (policy)
    const lite = node.ownerDocument.createElement('lite-youtube')
    lite.setAttribute('videoid', youtube.videoId)
    if (youtube.params !== '') lite.setAttribute('params', youtube.params)
    const title = node.getAttribute('title')
    if (title) lite.setAttribute('title', title)
    return lite
  }

  const tag = node.tagName.toLowerCase()
  const policy = POLICY[tag]
  if (policy) {
    // Drop attributes outside the policy for this element.
    for (const attr of [...node.attributes]) {
      const allowed = (policy.urlAttrs ?? []).includes(attr.name) || policy.attrs.includes(attr.name)
      if (!allowed && !['class', 'title', 'lang', 'dir', 'id'].includes(attr.name)) node.removeAttribute(attr.name)
    }
    for (const [, attr] of URL_ATTRS) {
      if (node.hasAttribute(attr)) resolveOrDrop(node, attr, feedBaseUrl)
    }
    // Non-http(s) link targets never survive.
    if (tag === 'a' && node.hasAttribute('href')) {
      node.setAttribute('rel', 'noopener noreferrer')
      node.setAttribute('target', '_blank')
    }
  }

  for (const child of [...node.children]) {
    const replacement = walk(child, feedBaseUrl)
    if (replacement === null) child.remove()
    else if (replacement !== child) child.replaceWith(replacement)
  }
  return node
}

/** Raw stored HTML → transformed display HTML (still untrusted until sunk). */
export function transformEntryContent(rawHtml: string, feedBaseUrl: string): string {
  const doc = Document.parseHTMLUnsafe(rawHtml)
  const body = doc.body
  walk(body, feedBaseUrl)
  return body.innerHTML
}

/** Sink transformed HTML into an element through a safe sanitizer. */
export function sinkEntryContent(target: Element, transformedHtml: string): void {
  // The Sanitizer API config shape is still settling across engines; the
  // policy adapter passes its table through and falls back to setHTML's safe
  // DEFAULT sanitizer if the engine rejects the config (day-one smoke test
  // reconciles this — plan Phase 4).
  const SanitizerCtor = (globalThis as unknown as { Sanitizer?: new (config?: unknown) => unknown }).Sanitizer
  const setHTML = (target as unknown as { setHTML?: (html: string, opts?: unknown) => void }).setHTML
  if (SanitizerCtor && typeof setHTML === 'function') {
    const config = toSanitizerConfig()
    try {
      setHTML.call(target, transformedHtml, {
        sanitizer: new SanitizerCtor(config),
      })
      return
    } catch (error) {
      // Engine rejected the policy config: fall back to setHTML's safe DEFAULT
      // sanitizer (less tailored) and leave markers for the smoke suite.
      target.setAttribute('data-sink-fallback', '')
      target.setAttribute('data-sink-error', String(error))
      setHTML.call(target, transformedHtml)
      return
    }
  }
  const config = toDomPurifyConfig()
  target.innerHTML = DOMPurify.sanitize(transformedHtml, {
    ALLOWED_TAGS: config.ALLOWED_TAGS,
    ALLOWED_ATTR: config.ALLOWED_ATTR,
    CUSTOM_ELEMENT_HANDLING: config.CUSTOM_ELEMENT_HANDLING,
    ALLOWED_URI_REGEXP: config.ALLOWED_URI_REGEXP,
  }) as unknown as string
}
