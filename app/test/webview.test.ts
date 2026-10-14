/**
 * Behavior suite: real browser, real sanitization (Bun.WebView).
 *
 * Runs on demand (`bun run test:webview`): it needs a display/headless-Chrome
 * environment, so it is skipped in plain `bun test` runs. On Linux Bun.WebView
 * drives Chrome — exercising the `Element.setHTML()` sink; on macOS it is
 * WKWebView — exercising the DOMPurify fallback. Both paths run the same
 * assertions, and the suite reports which sink was live.
 *
 * The fixture entry is hostile feed HTML: script, event handler, javascript:
 * URL, relative URL, and a YouTube iframe (must become <lite-youtube>).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDatabase } from '../src/server/db'
import { epochMs, newCategoryId, newEntryId, newFeedId, newUserId } from '../src/shared/ids'

const enabled = process.env.WEBVIEW === '1'
const PORT = 4820
const BASE = `http://localhost:${PORT}`

const HOSTILE_HTML = [
  '<p onclick="alert(1)">hello</p>',
  '<script>alert(2)</script>',
  '<iframe src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"></iframe>',
  '<a href="/relative">rel</a>',
  '<img src="javascript:alert(3)">',
  // xkcd's shape: the image title is the joke (Miniflux's add_image_title).
  '<img src="https://imgs.xkcd.com/comics/standards.png" title="Alt text: the comic joke">',
].join('')

let server: ReturnType<typeof spawn> | undefined
let fixtureDbPath = ''

beforeAll(async () => {
  if (!enabled) return
  const dbPath = join(mkdtempSync(join(tmpdir(), 'webview-db-')), 'reader.sqlite')
  fixtureDbPath = dbPath
  const handle = openDatabase(dbPath)
  const now = epochMs(Date.now())
  const userId = newUserId(now)
  handle.sqlite.run('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)', [
    userId,
    'spiffy',
    Bun.password.hashSync('correct-horse', { algorithm: 'argon2id' }),
    now,
  ])
  handle.sqlite.run('INSERT INTO categories (id, user_id, title, created_at) VALUES (?, ?, ?, ?)', [
    newCategoryId(now),
    userId,
    'Tech',
    now,
  ])
  const feedId = newFeedId(now)
  handle.sqlite.run(
    'INSERT INTO feeds (id, user_id, category_id, title, feed_url, site_url, created_at) VALUES (?, ?, (SELECT id FROM categories), ?, ?, ?, ?)',
    [feedId, userId, 'Blog', 'https://example.com/feed', 'https://example.com/', now],
  )
  handle.sqlite.run(
    `INSERT INTO entries (id, user_id, feed_id, hash, title, url, content, published_at, created_at, changed_at)
     VALUES (?, ?, ?, 'h1', 'Hostile entry', 'https://xkcd.com/927/', ?, ?, ?, ?)`,
    [newEntryId(now), userId, feedId, HOSTILE_HTML, now, now, now],
  )
  // A window's worth of plain rows (VIEW_PAGE_SIZE = 100) so the sentinel has a
  // second page to pull and auto-read has entries to scroll past.
  const insert = handle.sqlite.prepare(
    `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (let i = 1; i <= 119; i++) {
    // The entry at #50 carries a titled image on a NON-comic URL: the rewrite
    // must leave it alone (the rule keys off the entry's domain). #50 is inside
    // the first window whichever way the list is ordered.
    const content = i === 50 ? '<p>body</p><img src="https://example.com/x.png" title="Not a comic">' : '<p>body</p>'
    insert.run(newEntryId(now), userId, feedId, `plain-${i}`, `Plain ${i}`, content, now + i * 1000, now, now)
  }
  handle.sqlite.run('UPDATE feeds SET parsing_error_count = 1 WHERE id = ?', [feedId])
  handle.sqlite.close()

  server = spawn('bun', ['build/index.js'], {
    env: { ...process.env, READER_DB_PATH: dbPath, PORT: String(PORT), SESSION_SECRET: 'webview-smoke', NODE_ENV: 'production', SCHEDULER_ENABLED: '0' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`${BASE}/api/session`)
      if (res.ok) break
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100))
  }
})

afterAll(() => {
  if (typeof Bun !== 'undefined' && 'WebView' in Bun) Bun.WebView.closeAll()
  server?.kill()
})

const it = enabled ? test : test.skip

/** Poll a page-side expression until it is truthy (or the deadline passes). */
const until = (script: string, timeoutMs = 8000): string => `
  (() => {
    const deadline = Date.now() + ${timeoutMs}
    return new Promise((resolve) => {
      const tick = () => {
        const v = (() => { ${script} })()
        if (v) return resolve(v)
        if (Date.now() > deadline) return resolve(v)
        setTimeout(tick, 100)
      }
      tick()
    })
  })()
`

it(
  'display pipeline sanitizes hostile HTML in a real browser',
  async () => {
  const view = new Bun.WebView({ width: 1100, height: 800 })
  try {
    // Session through the same cookie-setting API the login form uses
    // (avoids racing hydration with a native form submit).
    await view.navigate(`${BASE}/login`)
    const loginOk = await view.evaluate(`
      fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'spiffy', password: 'correct-horse' }),
      }).then((r) => r.ok)
    `)
    console.log('login ok:', loginOk)
    await view.navigate(`${BASE}/`)
    await view.evaluate(`
      fetch('/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: {} }) })
        .then(async (r) => { window.__diag = { status: r.status, body: (await r.text()).slice(0, 400) } })
    `)
    // Wait for the entry card to fetch and sink its body.
    await view.evaluate(`
      (() => {
        const deadline = Date.now() + 5000
        return new Promise((resolve) => {
          const tick = () => {
            const content = document.querySelector('.reading')
            if ((content && content.childNodes.length > 0) || Date.now() > deadline) return resolve(true)
            setTimeout(tick, 50)
          }
          tick()
        })
      })()
    `)

    const report = (await view.evaluate(`
      (() => {
        const content = document.querySelector('.reading')
        const link = content && content.querySelector('a')
        return {
          sink: typeof Element.prototype.setHTML === 'function' ? 'setHTML' : 'dompurify',
          probe: (() => {
            const out = {}
            try {
              const a = document.createElement('div')
              a.setHTML('<lite-youtube videoid="x"></lite-youtube><b onclick="y">z</b>', {
                sanitizer: new Sanitizer({
                  elements: ['lite-youtube', 'b'],
                  attributes: { 'lite-youtube': ['videoid'], b: [] },
                  allowCustomElements: true,
                }),
              })
              out.policyShape = a.innerHTML
            } catch (e) {
              out.policyError = String(e)
            }
            const b = document.createElement('div')
            b.setHTML('<lite-youtube videoid="x"></lite-youtube><a href="https://x.example/y">z</a>')
            out.defaultShape = b.innerHTML
            const c = document.createElement('div')
            c.setHTML('<lite-youtube videoid="x"></lite-youtube>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: true,
              }),
            })
            out.elementObjectsShape = c.innerHTML
            const d = document.createElement('div')
            d.setHTML('<foo-bar>x</foo-bar><b>ok</b>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: true,
              }),
            })
            out.unlistedCustomAllowed = d.innerHTML
            const e = document.createElement('div')
            e.setHTML('<foo-bar>x</foo-bar><lite-youtube videoid="y"></lite-youtube><b>ok</b>', {
              sanitizer: new Sanitizer({
                elements: [{ name: 'lite-youtube', attributes: ['videoid'] }, 'b'],
                allowCustomElements: false,
              }),
            })
            out.customFalseShape = e.innerHTML
            return out
          })(),
          contentHtml: content ? content.innerHTML : null,
          path: location.pathname,
          articles: document.querySelectorAll('article').length,
          mainText: (document.querySelector('main') || document.body).innerText.slice(0, 200),
          diag: window.__diag || null,
          sidebarPanel: !!document.querySelector('[data-testid="feed-panel"]'),
          sections: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Sections') ?? false,
          hasLatest: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Latest') ?? false,
          hasStarred: document.querySelector('[data-testid="feed-panel"]')?.textContent?.includes('Starred') ?? false,
          hasBrand: document.body.textContent?.includes('Miniflux Reader') ?? false,
          feedMenu: !!document.querySelector('[data-testid="feed-menu-trigger"]'),
          bodyOverflow: getComputedStyle(document.body).overflow,
          documentScrolls: (document.scrollingElement?.scrollHeight ?? 0) > window.innerHeight + 1,
          listScrolls: (() => {
            const el = document.querySelector('[data-testid="entry-scroll"]')
            if (!el) return false
            el.scrollTop = 50
            return el.scrollTop > 0
          })(),
          sinkFallback: !!content && content.hasAttribute('data-sink-fallback'),
          sinkError: content ? content.getAttribute('data-sink-error') : null,
          hasScript: !!content && !!content.querySelector('script'),
          hasOnclick: !!content && !!content.querySelector('[onclick]'),
          hasJsUrl: !!content && Array.from(content.querySelectorAll('img')).some((i) => (i.getAttribute('src') || '').startsWith('javascript:')),
          imgLoading: content?.querySelector('img')?.getAttribute('loading') ?? null,
          hasLiteYoutube: !!content && !!content.querySelector('lite-youtube'),
          liteVideoId: content && content.querySelector('lite-youtube') ? content.querySelector('lite-youtube').getAttribute('videoid') : null,
          // The element existing is not enough: the lite-youtube-embed module must
          // have been imported, or the custom element never upgrades and nothing
          // renders. It builds light DOM (a play button), not a shadow root.
          liteDefined: !!customElements.get('lite-youtube'),
          liteUpgraded: !!(content && content.querySelector('lite-youtube .lyt-playbtn')),
          // …and its stylesheet must be loaded too: the package ships the CSS as a
          // separate file (its "style" field), unstyled the poster never appears.
          // …and the package's stylesheet must be applied: it ships the CSS as a
          // separate file (its "style" field). Unstyled, the element stays
          // display:inline with no poster — just a bare "Play" button.
          liteStyled: (() => {
            const el = content && content.querySelector('lite-youtube')
            return !!el && getComputedStyle(el).display === 'block'
          })(),
          // Miniflux's add_image_title: the comic image's title (xkcd's joke)
          // becomes a visible caption, and the tooltip is dropped.
          comicCaption: content ? (content.querySelector('figcaption')?.textContent ?? null) : null,
          comicImgTitle: content?.querySelector('figure img')?.getAttribute('title') ?? null,
          linkHref: link ? link.getAttribute('href') : null,
          warnEmoji: /\\u26A0\\uFE0F/.test(document.body.textContent ?? ''),
          warnBare: /\\u26A0(?!\\uFE0F)/.test(document.body.textContent ?? ''),
        }
      })()
    `)) as {
      sink: string
      probe: Record<string, string>
      contentHtml: string | null
      sinkFallback: boolean
      sinkError: string | null
      path: string
      articles: number
      mainText: string
      diag: unknown
      sidebarPanel: boolean
      sections: boolean
      hasLatest: boolean
      hasStarred: boolean
      hasBrand: boolean
      feedMenu: boolean
      bodyOverflow: string
      documentScrolls: boolean
      listScrolls: boolean
      hasScript: boolean
      hasOnclick: boolean
      hasJsUrl: boolean
      imgLoading: string | null
      hasLiteYoutube: boolean
      liteVideoId: string | null
      liteDefined: boolean
      liteUpgraded: boolean
      liteStyled: boolean
      comicCaption: string | null
      comicImgTitle: string | null
      linkHref: string | null
      warnEmoji: boolean
      warnBare: boolean
    }

    console.log(`display sink under test: ${report.sink}`)
    console.log('sanitizer probe:', JSON.stringify(report.probe))
    console.log('content html:', JSON.stringify(report.contentHtml), 'fallback:', report.sinkFallback, 'error:', report.sinkError, 'path:', report.path)
    console.log('diag:', JSON.stringify(report.diag), 'articles:', report.articles, 'main:', JSON.stringify(report.mainText))
    const pencil = (await view.evaluate(`
      (() => {
        const b = document.querySelector('button[title="Rename feed"]')
        if (!b) return { exists: false }
        const r = b.getBoundingClientRect()
        const cs = getComputedStyle(b)
        return { exists: true, w: r.width, h: r.height, x: r.x, y: r.y, opacity: cs.opacity, display: cs.display, visibility: cs.visibility, text: b.textContent }
      })()
    `)) as Record<string, unknown>
    console.log('pencil probe:', JSON.stringify(pencil))
    await view.evaluate(`document.body.style.zoom = '3'`)
    const png = await view.screenshot()
    await Bun.write('/tmp/pi-safetynet/01a126c0-9633-76d0-bd69-c747032718a4/ui.png', png)
    // force the hover-reveal pencil visible for the screenshot
    await view.evaluate(`(() => {
      const panel = document.querySelector('[data-testid="feed-panel"]')
      panel.style.zoom = '2'
      panel.scrollTop = 260
      document.querySelectorAll('button[title="Rename feed"]').forEach((b) => (b.style.opacity = '1'))
      document.querySelectorAll('[data-testid="feed-count"]').forEach((e) => (e.style.opacity = '0'))
      return true
    })()`)
    const png2 = await view.screenshot()
    await Bun.write('/tmp/pi-safetynet/01a126c0-9633-76d0-bd69-c747032718a4/ui-hover.png', png2)
    // Click the hover-pencil: the rename editor must take the cursor on appear.
    const renameFocus = (await view.evaluate(`
      (() => {
        document.querySelector('button[title="Rename feed"]').click()
        return new Promise((resolve) => {
          const deadline = Date.now() + 2000
          const tick = () => {
            const input = document.querySelector('[data-testid="feed-panel"] input')
            if (input && document.activeElement === input) return resolve({ found: true, focused: true })
            if (Date.now() > deadline) return resolve({ found: !!input, focused: false })
            setTimeout(tick, 25)
          }
          tick()
        })
      })()
    `)) as { found: boolean; focused: boolean }
    console.log('rename focus probe:', JSON.stringify(renameFocus))
    expect(report.hasScript).toBe(false) // <script> stripped
    // The chrome itself — the navbar and sidebar the old app had (regression
    // guard for the port: these must survive any future restyle pass).
    expect(report.sidebarPanel).toBe(true) // FeedPanel aside present
    expect(report.sections).toBe(true) // "Sections" heading
    expect(report.hasLatest).toBe(true) // Latest row (with total unread)
    expect(report.hasStarred).toBe(true) // Starred row
    expect(report.hasBrand).toBe(true) // "Miniflux Reader" brand
    expect(report.feedMenu).toBe(true) // feed-menu trigger (per-feed options)
    // Scrolling contract: the document never scrolls; the panes do. Auto-read's
    // scroll listener, next/prev scrollToEntry and the sidebar all ride on it.
    expect(report.bodyOverflow).toBe('hidden')
    expect(report.documentScrolls).toBe(false)
    expect(report.listScrolls).toBe(true)
    expect(renameFocus.focused).toBe(true) // rename editor takes the cursor when it appears
    expect(report.hasOnclick).toBe(false) // event handlers stripped
    expect(report.hasJsUrl).toBe(false) // javascript: URL stripped
    expect(report.imgLoading).toBe('lazy') // applyEmbedHints: the old lazyHtml pass
    expect(report.hasLiteYoutube).toBe(true) // YouTube iframe → custom element
    expect(report.liteVideoId).toBe('dQw4w9WgXcQ')
    expect(report.liteDefined).toBe(true) // lite-youtube-embed imported (defines the element)
    expect(report.liteUpgraded).toBe(true) // …so the preview actually rendered
    expect(report.liteStyled).toBe(true) // …and its stylesheet loaded (poster visible)
    expect(report.comicCaption).toBe('Alt text: the comic joke') // xkcd alt text rendered
    expect(report.comicImgTitle).toBe(null) // …and the tooltip dropped (MF parity)
    expect(report.linkHref).toBe('https://example.com/relative') // relative → absolute against feed base
    // fetch-error glyph: yellow ⚠️ (emoji presentation), never a bare/text ⚠ (renders red).
    expect(report.warnEmoji).toBe(true)
    expect(report.warnBare).toBe(false)
  } finally {
    await view.close()
  }
}, 30_000)

it(
  'reading behaviours: windowing, auto-read on scroll, and click semantics',
  async () => {
    const view = new Bun.WebView({ width: 1100, height: 800 })
    try {
      await view.navigate(`${BASE}/login`)
      await view.evaluate(`
        fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'spiffy', password: 'correct-horse' }) }).then((r) => r.ok)
      `)
      await view.navigate(`${BASE}/`)
      await view.evaluate(`
        fetch('/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filter: {} }) }).then((r) => r.status)
      `)

      const readState = (i: number): string =>
        `const a = document.querySelectorAll("article")[${i}]; return a && a.className.includes("bg-gray-50") ? "read" : "unread"`

      // First window only (VIEW_PAGE_SIZE), and nothing is read before the user
      // has scrolled — visibility alone marks nothing (old auto-read.spec).
      const firstWindow = (await view.evaluate(
        until('const n = document.querySelectorAll("article").length; return n > 0 ? n : 0'),
      )) as number
      console.log('first window:', firstWindow, '| article 0:', await view.evaluate(`(() => { ${readState(0)} })()`))
      expect(firstWindow).toBe(100)
      expect((await view.evaluate(`(() => { ${readState(0)} })()`)) as string).toBe('unread')

      // Scrolling to the sentinel pulls the next window (old pagination.spec).
      // Target the sentinel itself: the list's 100dvh bottom padding sits below
      // it, so jumping to scrollHeight overshoots the observer's rootMargin.
      const scrolled = (await view.evaluate(`
        (() => {
          const el = document.querySelector('[data-testid="entry-scroll"]')
          const s = document.getElementById('entry-sentinel')
          const top = s.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
          el.scrollTop = top - el.clientHeight + 100
          return Math.round(el.scrollTop)
        })()
      `)) as number
      const articles = (await view.evaluate(
        until('const n = document.querySelectorAll("article").length; return n >= 120 ? n : 0'),
      )) as number
      console.log('scrolled to sentinel:', scrolled, '| windowed articles:', articles)
      expect(articles).toBeGreaterThan(100)

      // Auto-read: entries the scroll carried above the band are read, the ones
      // still below it are not.
      await view.evaluate(`(() => { const el = document.querySelector('[data-testid="entry-scroll"]'); el.scrollTop = 2400; return el.scrollTop })()`)
      const firstAfter = (await view.evaluate(until(`${readState(0)} === "read" ? "read" : ""`))) as string
      const farState = (await view.evaluate(`(() => { ${readState(115)} })()`)) as string
      console.log('auto-read:', firstAfter, '| far entry:', farState)
      expect(firstAfter).toBe('read')
      expect(farState).toBe('unread')

      // Click semantics (restored): a link click marks read; a card-body click
      // only toggles the fold. Use entries the scroll left below the band.
      const unreadIds = (await view.evaluate(`
        (() => [...document.querySelectorAll('article')]
          .filter((a) => !a.className.includes('bg-gray-50'))
          .slice(-2)
          .map((a) => a.getAttribute('data-entry-id')))()
      `)) as string[]
      expect(unreadIds.length).toBe(2)
      const [linkId, cardId] = unreadIds as [string, string]

      await view.evaluate(`(() => { document.querySelector('[data-entry-id="${linkId}"] a').click(); return true })()`)
      const linkRead = (await view.evaluate(
        until(`const a = document.querySelector('[data-entry-id="${linkId}"]'); return a && a.className.includes("bg-gray-50") ? "read" : ""`),
      )) as string
      expect(linkRead).toBe('read')

      const cardState = (await view.evaluate(
        `(() => { const a = document.querySelector('[data-entry-id="${cardId}"]'); return a.className.includes('bg-gray-50') ? 'read' : 'unread' })()`,
      )) as string
      console.log('link click ->', linkRead, '| card-body click state:', cardState)
      expect(cardState).toBe('unread')
    } finally {
      await view.close()
    }
  },
  45_000,
)

it(
  'URL shape survives the back button',
  async () => {
    const view = new Bun.WebView({ width: 1100, height: 800 })
    try {
      await view.navigate(`${BASE}/login`)
      await view.evaluate(`
        fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'spiffy', password: 'correct-horse' }) }).then((r) => r.ok)
      `)
      await view.navigate(`${BASE}/`)
      await view.evaluate(`
        fetch('/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filter: {} }) }).then((r) => r.status)
      `)
      await view.evaluate(until('return document.querySelectorAll("article").length > 0 ? 1 : 0'))

      const href = (await view.evaluate(`
        (() => {
          const a = [...document.querySelectorAll('a')].find((x) => (x.getAttribute('href') ?? '').includes('feed='))
          if (!a) return null
          a.click()
          return a.getAttribute('href')
        })()
      `)) as string | null
      await view.evaluate(until('return location.search.includes("feed=") ? 1 : 0'))
      const afterClick = (await view.evaluate(`location.pathname + location.search`)) as string

      await view.evaluate(`history.back()`)
      await view.evaluate(until('return location.search.includes("feed=") ? 0 : 1'))
      const afterBack = (await view.evaluate(`location.pathname + location.search`)) as string
      console.log('URL probe — link:', href, '| after click:', afterClick, '| after back:', afterBack)
      expect(afterClick).toContain('feed=')
      expect(afterBack).toBe('/')
    } finally {
      await view.close()
    }
  },
  45_000,
)

it(
  'header names a feed the sidebar hides (everything read, unread-only view)',
  async () => {
    // Read every entry in the fixture: the feed now has nothing unread, so the
    // sidebar drops it — the header must still name it (it showed "Feed <uuid>").
    const handle = openDatabase(fixtureDbPath)
    const feedId = (handle.sqlite.query('SELECT id FROM feeds LIMIT 1').get() as { id: string }).id
    handle.sqlite.run("UPDATE entries SET status = 'read'; UPDATE feeds SET parsing_error_count = 0")
    handle.sqlite.close()

    const view = new Bun.WebView({ width: 1100, height: 800 })
    try {
      await view.navigate(`${BASE}/login`)
      await view.evaluate(`
        fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'spiffy', password: 'correct-horse' }) }).then((r) => r.ok)
      `)
      // Does the server keep the view's feed in the sidebar payload?
      const api = (await view.evaluate(`
        fetch('/api/panel?feed=${feedId}').then((r) => r.json())
          .then((j) => ({ feeds: j.feeds.map((f) => f.title) }))
      `)) as { feeds: string[] }

      await view.navigate(`${BASE}/?feed=${feedId}`)
      // Wait for the CORRECT label (the id fallback renders first, so a
      // non-empty check would resolve instantly).
      const label = (await view.evaluate(
        until(
          `const t = document.querySelector('[data-testid="feed-menu-trigger"]'); const v = t ? t.textContent.trim() : ''; return v.startsWith('Blog') ? v : ''`,
          5000,
        ),
      )) as string
      const finalLabel = (await view.evaluate(
        `(() => { const t = document.querySelector('[data-testid="feed-menu-trigger"]'); return t ? t.textContent.trim() : '' })()`,
      )) as string
      console.log('sidebar feeds for the view:', JSON.stringify(api.feeds))
      console.log('header label:', JSON.stringify(finalLabel), '| resolved:', JSON.stringify(label))
      expect(api.feeds).toEqual(['Blog']) // the view's feed stays in the sidebar
      expect(finalLabel.startsWith('Blog')).toBe(true)
      expect(finalLabel.includes(feedId)).toBe(false)
    } finally {
      await view.close()
    }
  },
  45_000,
)

// Runs last: it expands an entry (which marks it read).
it(
  'the comic rewrite leaves other domains alone',
  async () => {
    const view = new Bun.WebView({ width: 1100, height: 800 })
    try {
      await view.navigate(`${BASE}/login`)
      await view.evaluate(`
        fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'spiffy', password: 'correct-horse' }) }).then((r) => r.ok)
      `)
      // The previous test marks everything read, and the default view is
      // unread-only: restore the list so there are cards to expand.
      const handle = openDatabase(fixtureDbPath)
      handle.sqlite.run("UPDATE entries SET status = 'unread'")
      handle.sqlite.close()
      await view.navigate(`${BASE}/`)
      // Expand the entry whose image carries a title on a NON-comic URL.
      const clicked = (await view.evaluate(
        until(`
          const card = [...document.querySelectorAll('[data-entry-id]')].find(
            (c) => (c.querySelector('.msubject')?.textContent ?? '').trim() === 'Plain 50',
          )
          if (!card) return ''
          card.click()
          return card.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'clicked'
        `),
      )) as string
      console.log('plain-entry expansion:', clicked)
      const kept = (await view.evaluate(
        until(`return document.querySelector('img[title="Not a comic"]') ? 'kept' : ''`),
      )) as string
      expect(kept).toBe('kept') // the rule keys off the entry's domain, not the feed
    } finally {
      await view.close()
    }
  },
  45_000,
)
