// playground/scripts/capture-feed-menu.ts
//
// Renders the reader against mocked APIs and screenshots the feed popover, so
// the toolbar can be reviewed at a real viewport without a backend or a login.
// Prints measured geometry alongside the image, because "does the fill read as a
// button" is a judgement call but "did a label wrap to two lines" is a fact.
//
//   bunx vite --port 5173 &          # or: bun run dev
//   bun playground/scripts/capture-feed-menu.ts 390 844 /tmp/feed-menu-390.png
//
// Playwright's driver expects Node; run this with `bun` only if it works, else
// `node --experimental-strip-types`.

import { chromium } from '@playwright/test'

const base = 'http://localhost:5173'
const width = Number(process.argv[2] ?? 390)
const height = Number(process.argv[3] ?? 844)
const out = process.argv[4] ?? `/tmp/feed-menu-${width}.png`
// e.g. '?feed=7' for a feed view, '?starred=1' for an aggregate.
const query = process.argv[5] ?? ''
// ON_STYLE=dark-text keeps the cyan fill but a dark label; ON_STYLE=grey drops the
// cyan entirely for a pressed-grey fill. Both are injected, not source edits, so
// variants can be compared without touching the component.
const onStyle = process.env['ON_STYLE'] ?? 'accent'

const feed = {
  id: 7,
  user_id: 1,
  title: 'Techno Blog',
  site_url: 'https://example.test',
  feed_url: 'https://example.test/feed.xml',
  category: { id: 10, title: 'Tech', user_id: 1 },
  icon: null,
}

const entries = Array.from({ length: 8 }, (_, i) => ({
  id: 100 + i,
  user_id: 1,
  feed_id: 7,
  title: `An entry about something interesting, number ${i + 1}`,
  url: 'https://example.test/a',
  author: 'A. Writer',
  content: '<p>Some body text for the reading pane.</p>',
  published_at: new Date(Date.now() - i * 3600e3).toISOString(),
  status: 'unread',
  starred: false,
  reading_time: 3,
  feed,
}))

const bootstrap = {
  entries,
  nextCursor: null,
  hasMore: false,
  feeds: [feed],
  categories: [{ id: 10, title: 'Tech', total_unread: 12, feed_count: 1 }],
  counters: { 7: 12 },
  userPrefs: { hideEmptyFeeds: true, disabledAutoReadFeeds: [] },
  feedPrefs: { 7: { viewMode: 'expanded', sort: 'oldest', hideReadItems: true } },
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 })

// Injected at author-origin, unlayered, so it beats Tailwind's layered utilities.
const onStyleCss: Record<string, string> = {
  accent: '',
  'dark-text': ".menu-row[aria-pressed='true'] { color: var(--color-ink) }",
  grey: ".menu-row[aria-pressed='true'] { background-color: #e5e7eb; color: var(--color-ink) }",
}

await page.route('**/api/miniflux/**', (route) => {
  const path = new URL(route.request().url()).pathname
  const json = (body: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
  if (path.endsWith('/session')) return json({ authenticated: true, username: 'me' })
  if (path.endsWith('/bootstrap')) return json(bootstrap)
  if (path.endsWith('/counters')) return json(bootstrap.counters)
  if (path.endsWith('/panel')) return json({ feeds: bootstrap.feeds, categories: bootstrap.categories, counters: bootstrap.counters })
  if (path.endsWith('/entries')) return json({ entries, nextCursor: null, hasMore: false })
  return json({})
})

await page.goto(`${base}/${query}`, { waitUntil: 'networkidle' })
if (onStyleCss[onStyle]) await page.addStyleTag({ content: onStyleCss[onStyle] })
await page.getByTestId('feed-menu-count').waitFor()
await page.getByTestId('feed-menu-trigger').click()
await page.waitForTimeout(400)

const info = await page.evaluate(() => {
  const panel = document.querySelector('#feed-menu') as HTMLDialogElement
  const rect = (el: Element) => el.getBoundingClientRect()
  const rows = [...panel.querySelectorAll('.menu-row')] as HTMLElement[]
  const cell = rows[0]
  const backdrop = getComputedStyle(panel, '::backdrop')
  return {
    interLoaded: document.fonts.check('14px Inter'),
    isModal: panel.open && panel.matches(':modal'),
    scrim: backdrop.backgroundColor,
    // What the scrim actually intercepts: the element under the cursor at a
    // point well outside the panel.
    topElementAtPoint: document.elementFromPoint(20, 300)?.tagName ?? null,
    panel: {
      top: Math.round(rect(panel).top),
      width: Math.round(rect(panel).width),
      height: Math.round(rect(panel).height),
      scrollsInternally: panel.scrollHeight > panel.clientHeight,
      bg: getComputedStyle(panel).backgroundColor,
    },
    // 44 = one line, more = a label wrapped.
    rowHeights: rows.map((r) => Math.round(rect(r).height)),
    rowFills: [...new Set(rows.map((r) => getComputedStyle(r).backgroundColor))],
    gridColumnWidth: Math.round(rect(cell).width),
    // Slack available to the longest label, after the cell's own padding.
    longestLabelSlack: Math.round(
      rect(cell).width -
        parseFloat(getComputedStyle(cell).paddingLeft) -
        parseFloat(getComputedStyle(cell).paddingRight),
    ),
    // Natural (unwrapped) width of the longest grid label, measured in the row's
    // own font. Compare against longestLabelSlack: wrapping happens when the
    // label needs more room than the cell can give it.
    longestLabelNaturalWidth: (() => {
      const labels = rows.map((r) => r.textContent?.trim() ?? '')
      const longest = labels.sort((a, b) => b.length - a.length)[0] ?? ''
      const host = rows.find((r) => (r.textContent?.trim() ?? '') === longest)
      if (!host) return null
      const probe = document.createElement('span')
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:nowrap;font:inherit;letter-spacing:inherit'
      probe.textContent = longest
      host.appendChild(probe)
      const w = Math.round(probe.getBoundingClientRect().width)
      probe.remove()
      return { label: longest, width: w }
    })(),
    viewportHeight: window.innerHeight,
  }
})
console.log(JSON.stringify(info, null, 2))

await page.screenshot({ path: out })
console.log(`wrote ${out}`)

// Inertness probe: click straight at an entry link sitting behind the scrim and
// see whether anything back there receives it. The entry links are target="_blank",
// so a click that gets through would open a tab.
const panelBottom = info.panel.top + info.panel.height
let target: { x: number; y: number } | null = null
for (const link of await page.locator('a.msubject').all()) {
  const box = await link.boundingBox()
  if (box && box.y > panelBottom + 10 && box.y + box.height < height - 20) {
    target = { x: box.x + 4, y: box.y + 4 }
    break
  }
}
if (target) {
  const tabsBefore = page.context().pages().length
  await page.mouse.click(target.x, target.y)
  await page.waitForTimeout(400)
  console.log(
    JSON.stringify({
      probedBehindScrimAt: target,
      newTabsOpened: page.context().pages().length - tabsBefore,
      panelStillOpen: (await page.locator('#feed-menu').evaluate((el) => (el as HTMLDialogElement).open)) as boolean,
    }),
  )
} else {
  console.log('no entry link found below the panel to probe')
}

await browser.close()