import { createHmac, timingSafeEqual } from 'node:crypto'

const config = {
  minifluxUrl: process.env.minifluxUrl?.replace(/\/+$/, '') ?? 'https://miniflux.spiffy.tech',
  sessionSecret: process.env.sessionSecret,
}

function unsignSession(raw: string): { token: string } | null {
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return null
  const [b64, sig] = [raw.slice(0, dot), raw.slice(dot + 1)]
  let payload: string
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8')
  } catch {
    return null
  }
  if (!config.sessionSecret) throw new Error('sessionSecret not set in .env')
  const expected = createHmac('sha256', config.sessionSecret).update(payload).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(payload) as { token?: string }
    if (typeof parsed.token !== 'string') return null
    return { token: parsed.token }
  } catch {
    return null
  }
}

function resolveToken(): string {
  if (process.env.MF_TOKEN) return process.env.MF_TOKEN
  if (process.env.minifluxToken) return process.env.minifluxToken
  if (process.env.MF_SESSION) {
    const session = unsignSession(process.env.MF_SESSION)
    if (!session) throw new Error('MF_SESSION is invalid or tampered')
    return session.token
  }
  throw new Error('Set MF_TOKEN, minifluxToken (in .env), or MF_SESSION (signed mf_session cookie value).')
}

interface MinifluxFeed {
  id: number
  title: string
  feed_url: string
  category: { id: number; title: string } | null
  checked_at: string | null
  next_check_at: string | null
  parsing_error_count: number
  parsing_error_message: string
  disabled: boolean
}

const token = resolveToken()

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${config.minifluxUrl}/v1${path}`, {
    ...init,
    headers: {
      'X-Auth-Token': token,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error_message?: string }
      if (body.error_message) detail = body.error_message
    } catch {}
    throw new Error(`Miniflux ${res.status}: ${detail}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

const now = Date.now()

/** "2h 15m" / "3d 4h" / "45m" — humanized duration. */
function humanize(ms: number): string {
  const totalMin = Math.round(ms / 60000)
  if (totalMin < 60) return `${totalMin}m`
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days > 0) return `${days}d ${hours}h`
  if (mins === 0) return `${hours}h`
  return `${hours}h ${mins}m`
}

/** "3d ago" / "2h ago" / "just now" — relative time from now. */
function rel(ts: number): string {
  const diff = now - ts
  if (diff < 60_000) return 'just now'
  return `${humanize(diff)} ago`
}

interface Row {
  feed: MinifluxFeed
  lastRefresh: number | null
  nextCheck: number | null
  plannedMs: number | null
  flags: string[]
}

function buildRows(feeds: MinifluxFeed[]): Row[] {
  return feeds.map((feed) => {
    const lastRefresh = feed.checked_at ? new Date(feed.checked_at).getTime() : null
    const nextCheck = feed.next_check_at ? new Date(feed.next_check_at).getTime() : null
    const flags: string[] = []
    if (feed.disabled) flags.push('DISABLED')
    if (feed.parsing_error_count > 0) flags.push(`ERROR(${feed.parsing_error_count})`)
    if (lastRefresh === null) flags.push('NEVER')
    if (nextCheck !== null && nextCheck < now) flags.push('OVERDUE')
    return {
      feed,
      lastRefresh,
      nextCheck,
      plannedMs: lastRefresh !== null && nextCheck !== null ? nextCheck - lastRefresh : null,
      flags,
    }
  })
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

function printTable(rows: Row[]): void {
  const titleW = Math.min(34, Math.max(...rows.map((r) => r.feed.title.length), 12))
  const catW = Math.min(22, Math.max(...rows.map((r) => r.feed.category?.title.length ?? 0), 8))

  console.log(pad('FEED', titleW) + '  ' + pad('CATEGORY', catW) + '  ' +
    pad('LAST REFRESH', 34) + '  ' + pad('PLANNED', 12) + '  ' + pad('NEXT CHECK', 16) + '  FLAGS')
  console.log('-'.repeat(titleW + catW + 34 + 12 + 16 + 2 + 3 + 3 + 6))

  for (const r of rows) {
    const last = r.lastRefresh !== null
      ? `${pad(rel(r.lastRefresh), 14)} ${new Date(r.lastRefresh).toISOString().slice(0, 16)}`
      : pad('—', 14) + ' ' + 'never'.padEnd(16)
    const planned = r.plannedMs !== null ? humanize(r.plannedMs) : '—'
    const next = r.nextCheck !== null
      ? `${new Date(r.nextCheck).toISOString().slice(0, 16)} ${r.nextCheck < now ? '(overdue)' : ''}`
      : '—'
    console.log(
      pad(r.feed.title, titleW) + '  ' +
      pad(r.feed.category?.title ?? '', catW) + '  ' +
      pad(last, 34) + '  ' +
      pad(planned, 12) + '  ' +
      pad(next, 16) + '  ' +
      r.flags.join(', '),
    )
  }
}

function printSummary(rows: Row[]): void {
  const intervals = rows
    .map((r) => r.plannedMs)
    .filter((ms): ms is number => ms !== null && ms > 0)
    .sort((a, b) => a - b)
  const median = intervals.length
    ? intervals[Math.floor(intervals.length / 2)]
    : null
  const min = intervals[0]
  const max = intervals[intervals.length - 1]

  console.log('\nSummary')
  console.log(`  feeds:            ${rows.length}`)
  console.log(`  never refreshed:  ${rows.filter((r) => r.lastRefresh === null).length}`)
  console.log(`  disabled:         ${rows.filter((r) => r.feed.disabled).length}`)
  console.log(`  with errors:      ${rows.filter((r) => r.feed.parsing_error_count > 0).length}`)
  console.log(`  overdue:          ${rows.filter((r) => r.nextCheck !== null && r.nextCheck < now).length}`)
  console.log(`  planned interval: min ${min ? humanize(min) : '—'} · median ${median ? humanize(median) : '—'} · max ${max ? humanize(max) : '—'}`)
  console.log(`  (interval = next_check_at − checked_at, i.e. Miniflux's scheduled cadence, not observed)`)
}

const feeds = await request<MinifluxFeed[]>('/feeds')
const rows = buildRows(feeds)

// Never-refreshed first, then stalest (oldest checked_at) first.
rows.sort((a, b) => {
  if (a.lastRefresh === null && b.lastRefresh === null) return 0
  if (a.lastRefresh === null) return -1
  if (b.lastRefresh === null) return 1
  return a.lastRefresh - b.lastRefresh
})

printTable(rows)
printSummary(rows)
