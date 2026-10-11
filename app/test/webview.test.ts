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
].join('')

let server: ReturnType<typeof spawn> | undefined

beforeAll(async () => {
  if (!enabled) return
  const dbPath = join(mkdtempSync(join(tmpdir(), 'webview-db-')), 'reader.sqlite')
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
    `INSERT INTO entries (id, user_id, feed_id, hash, title, content, published_at, created_at, changed_at)
     VALUES (?, ?, ?, 'h1', 'Hostile entry', ?, ?, ?, ?)`,
    [newEntryId(now), userId, feedId, HOSTILE_HTML, now, now, now],
  )
  handle.sqlite.run('UPDATE feeds SET parsing_error_count = 1 WHERE id = ?', [feedId])
  handle.sqlite.close()

  server = spawn('bun', ['build/index.js'], {
    env: { ...process.env, READER_DB_PATH: dbPath, PORT: String(PORT), SESSION_SECRET: 'webview-smoke', NODE_ENV: 'production' },
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
          sinkFallback: !!content && content.hasAttribute('data-sink-fallback'),
          sinkError: content ? content.getAttribute('data-sink-error') : null,
          hasScript: !!content && !!content.querySelector('script'),
          hasOnclick: !!content && !!content.querySelector('[onclick]'),
          hasJsUrl: !!content && Array.from(content.querySelectorAll('img')).some((i) => (i.getAttribute('src') || '').startsWith('javascript:')),
          hasLiteYoutube: !!content && !!content.querySelector('lite-youtube'),
          liteVideoId: content && content.querySelector('lite-youtube') ? content.querySelector('lite-youtube').getAttribute('videoid') : null,
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
      hasScript: boolean
      hasOnclick: boolean
      hasJsUrl: boolean
      hasLiteYoutube: boolean
      liteVideoId: string | null
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
    expect(renameFocus.focused).toBe(true) // rename editor takes the cursor when it appears
    expect(report.hasOnclick).toBe(false) // event handlers stripped
    expect(report.hasJsUrl).toBe(false) // javascript: URL stripped
    expect(report.hasLiteYoutube).toBe(true) // YouTube iframe → custom element
    expect(report.liteVideoId).toBe('dQw4w9WgXcQ')
    expect(report.linkHref).toBe('https://example.com/relative') // relative → absolute against feed base
    // fetch-error glyph: yellow ⚠️ (emoji presentation), never a bare/text ⚠ (renders red).
    expect(report.warnEmoji).toBe(true)
    expect(report.warnBare).toBe(false)
  } finally {
    await view.close()
  }
}, 30_000)
