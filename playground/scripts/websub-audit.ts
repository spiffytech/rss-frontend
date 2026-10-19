/**
 * Which feeds advertise WebSub (rel="hub")? Fetches each feed and looks for the
 * hub/self link tags, plus the HTTP-level hints some publishers use instead.
 */
const feeds = JSON.parse(await Bun.file(process.argv[2] as string).text()) as { title: string; feed_url: string }[]

const results: {
  title: string
  url: string
  hub: string | null
  self: string | null
  via: string
  status: number | string
}[] = []

const CONCURRENCY = 4
let i = 0
async function worker() {
  while (i < feeds.length) {
    const f = feeds[i++]
    if (!f) continue
    try {
      const res = await fetch(f.feed_url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
        headers: { 'user-agent': 'websub-audit/1.0 (feed capability check)' },
      })
      const text = await res.text()
      const head = text.slice(0, 20_000)
      // <link rel="hub" href="...">  (rel may list several tokens)
      let hub: string | null = null
      let self: string | null = null
      const linkRe = /<link\b[^>]*>/gi
      let m: RegExpExecArray | null
      while ((m = linkRe.exec(head))) {
        const tag = m[0]
        const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase() ?? ''
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1] ?? ''
        if (rel.split(/\s+/).includes('hub') && !hub) hub = href
        if (rel.split(/\s+/).includes('self') && !self) self = href
      }
      const via =
        hub ? 'link-rel-hub'
          : /pubsubhubbub/i.test(head) ? 'pubsubhubbub-text'
          : res.headers.get('link')?.includes('rel=hub') ? 'http-link-header'
          : 'none'
      results.push({ title: f.title, url: f.feed_url, hub, self, via, status: res.status })
    } catch (e) {
      results.push({ title: f.title, url: f.feed_url, hub: null, self: null, via: 'fetch-error', status: String(e).slice(0, 40) })
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker))

const byVia = new Map<string, number>()
for (const r of results) byVia.set(r.via, (byVia.get(r.via) ?? 0) + 1)
console.log('=== WebSub advertisement, by mechanism ===')
for (const [k, n] of [...byVia].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`)

const hubs = new Map<string, number>()
for (const r of results) if (r.hub) hubs.set(r.hub, (hubs.get(r.hub) ?? 0) + 1)
console.log('\n=== hub endpoints ===')
for (const [h, n] of [...hubs].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${h}`)

console.log('\n=== feeds with a hub ===')
for (const r of results.filter((r) => r.hub).sort((a, b) => a.title.localeCompare(b.title)))
  console.log(`  ${r.title.slice(0, 40).padEnd(40)} ${r.hub}`)

const hosts = new Map<string, number>()
for (const r of results.filter((r) => r.hub)) {
  const h = new URL(r.url).hostname
  hosts.set(h, (hosts.get(h) ?? 0) + 1)
}
console.log('\n=== hubs by host ===')
for (const [h, n] of [...hosts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${h}`)
