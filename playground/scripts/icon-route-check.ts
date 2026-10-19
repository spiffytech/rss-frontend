/**
 * Scratch check: the feed-icon route's response policy.
 *
 * Mounts createProviderRoutes() with a stub provider behind a pass-through
 * gate, then asserts what each icon type comes back as. The cases that matter:
 * SVG is served but CSP-sandboxed, rasters are served without a CSP, a
 * script-bearing MIME is refused, and a provider error is a 404 with a short
 * cache so it heals.
 *
 * Run: bun playground/scripts/icon-route-check.ts
 */
import { createProviderRoutes } from '../../src/server/providers/routes'
import type { Provider } from '../../src/server/providers/types'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const HTML = '<html><script>alert(1)</script></html>'

function appWith(icon: { mime: string; body: Uint8Array } | 'error') {
  const provider = {
    getFeedIcon: async () => {
      if (icon === 'error') throw new Error('upstream 404')
      // Miniflux's model.Icon.DataURL() is `mime;base64,bytes` — no `data:`
      // scheme prefix.
      return {
        mime_type: icon.mime,
        data: `${icon.mime};base64,${Buffer.from(icon.body).toString('base64')}`,
      }
    },
  } as unknown as Provider
  return createProviderRoutes(provider, {
    getUserId: () => 1,
    gate: async (_c, next) => next(),
  })
}

const cases: Array<{
  name: string
  icon: { mime: string; body: Uint8Array } | 'error'
  want: { status: number; type?: string; csp?: string | null }
}> = [
  {
    name: 'svg icon (hnrss / Hacker News)',
    icon: { mime: 'image/svg+xml', body: new TextEncoder().encode(SVG) },
    want: { status: 200, type: 'image/svg+xml', csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
  },
  {
    name: 'svg with a charset parameter',
    icon: { mime: 'image/svg+xml; charset=utf-8', body: new TextEncoder().encode(SVG) },
    want: { status: 200, type: 'image/svg+xml', csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox" },
  },
  {
    name: 'png icon',
    icon: { mime: 'image/png', body: PNG },
    want: { status: 200, type: 'image/png', csp: null },
  },
  {
    name: 'html "icon" (stored-XSS attempt)',
    icon: { mime: 'text/html', body: new TextEncoder().encode(HTML) },
    want: { status: 404 },
  },
  {
    name: 'provider error',
    icon: 'error',
    want: { status: 404 },
  },
]

let failures = 0
for (const testCase of cases) {
  const res = await appWith(testCase.icon).request('/feeds/16/icon')
  const type = res.headers.get('content-type')
  const csp = res.headers.get('content-security-policy')
  const cache = res.headers.get('cache-control')
  const nosniff = res.headers.get('x-content-type-options')

  const problems: string[] = []
  if (res.status !== testCase.want.status) problems.push(`status ${res.status} != ${testCase.want.status}`)
  if (testCase.want.type !== undefined && !type?.startsWith(testCase.want.type)) {
    problems.push(`content-type ${type} != ${testCase.want.type}`)
  }
  if (testCase.want.csp !== undefined && (csp ?? null) !== testCase.want.csp) {
    problems.push(`csp ${csp} != ${testCase.want.csp}`)
  }
  if (testCase.want.status === 200 && nosniff !== 'nosniff') problems.push('missing nosniff')

  failures += problems.length > 0 ? 1 : 0
  console.log(
    `${problems.length === 0 ? 'ok  ' : 'FAIL'} ${testCase.name}\n` +
      `       status=${res.status} type=${type} nosniff=${nosniff} cache="${cache}"\n` +
      `       csp=${csp}\n` +
      (problems.length > 0 ? `       -> ${problems.join('; ')}\n` : ''),
  )
}

console.log(failures === 0 ? 'all cases passed' : `${failures} case(s) failed`)
process.exit(failures === 0 ? 0 : 1)
