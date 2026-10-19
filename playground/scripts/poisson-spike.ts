/**
 * Latency spike: non-homogeneous Poisson polling vs the current deterministic
 * placement, measured on real publish traces.
 *
 *   bun playground/scripts/poisson-spike.ts <trace.json>
 *
 * Train/test split is chronological and per feed: the density is learned from
 * the first 70% of each feed's publishes and latency is measured on the last
 * 30%. Evaluating on the training window would make every strategy look great.
 */
import { readFileSync } from 'node:fs'

const MINUTES_PER_DAY = 1440
const BINS = 48
const BIN = MINUTES_PER_DAY / BINS

type Trace = { title: string; host: string; publishedAt: number[] }[]

// ---------- minute-of-day helpers (circular, seam-safe) ----------

const minuteOfDay = (ts: number) => Math.floor(ts / 60_000) % MINUTES_PER_DAY

/** Rotate stamps so the circular gap that splits a mode sits at the seam. */
function rotate(stamps: number[]): { rot: number[]; seam: number } {
  const s = [...new Set(stamps)].sort((a, b) => a - b)
  if (s.length < 2) return { rot: stamps, seam: 0 }
  let bestGap = -1
  let seam = 0
  for (let i = 0; i < s.length; i++) {
    const a = s[i] as number
    const b = (s[(i + 1) % s.length] as number) + (i === s.length - 1 ? MINUTES_PER_DAY : 0)
    if (b - a > bestGap) {
      bestGap = b - a
      seam = b % MINUTES_PER_DAY
    }
  }
  return { rot: stamps.map((v) => (v - seam + MINUTES_PER_DAY) % MINUTES_PER_DAY), seam }
}

const toOrig = (v: number, seam: number) => (v + seam) % MINUTES_PER_DAY

function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))
  return sorted[i] as number
}

/** 48-bin circular density over minute-of-day, smoothed 3x with [1,2,1]/4. */
function learnDensity(stamps: number[], trainDays: number): number[] {
  const h = new Array<number>(BINS).fill(0)
  for (const m of stamps) h[Math.floor(m / BIN)] = (h[Math.floor(m / BIN)] as number) + 1
  let d = h
  for (let pass = 0; pass < 3; pass++) {
    const out = new Array<number>(BINS).fill(0)
    for (let i = 0; i < BINS; i++) {
      const l = d[(i - 1 + BINS) % BINS] as number
      const c = d[i] as number
      const r = d[(i + 1) % BINS] as number
      out[i] = (l + 2 * c + r) / 4
    }
    d = out
  }
  // items per minute
  return d.map((v) => v / Math.max(1, trainDays) / BIN)
}

const median = (xs: number[]) => (xs.length ? (xs[Math.floor(xs.length / 2)] as number) : 0)

// ---------- fetch-time generators ----------

/** Deterministic placement matching app/src/server/scheduler/model.ts.
 *  `mode` switches the placement rule only -- budget stays as the live code has it:
 *    q85   the shipped rule: one poll past the bulk of the mode
 *    tail  one poll past the OBSERVED TAIL + margin, so nothing published today
 *          waits until tomorrow
 *    tail2 budget floored at 2: one at q95, one past the tail + margin
 */
function currentFetches(
  mins: number[], trainDays: number, t0: number, t1: number,
  mode: 'q85' | 'tail' | 'tail2' = 'q85', marginMin = 20,
): number[] {
  const perDay = mins.length / Math.max(1, trainDays)
  const budget = Math.max(mode === 'tail2' ? 2 : 1, Math.ceil(perDay))
  const { rot, seam } = rotate(mins)
  const sorted = [...rot].sort((a, b) => a - b)
  const pts: number[] = []
  const tail = toOrig((sorted[sorted.length - 1] as number) ?? 0, seam)
  if (mode === 'tail2') {
    pts.push(toOrig(quantile(sorted, 0.5), seam))
    pts.push((tail + marginMin) % MINUTES_PER_DAY)
    for (let k = 3; k <= budget; k++) pts.push(toOrig(quantile(sorted, (k - 0.5) / budget), seam))
  } else if (budget === 1 && mode === 'tail') {
    pts.push((tail + marginMin) % MINUTES_PER_DAY)
  } else {
    for (let k = 1; k <= budget; k++) pts.push(toOrig(quantile(sorted, (k - 0.5) / budget), seam))
    if (mode === 'tail') {
      // Keep the budget; only move the LAST poll past the observed tail so
      // nothing published today waits until tomorrow.
      pts.pop()
      pts.push((tail + marginMin) % MINUTES_PER_DAY)
    }
  }
  const out: number[] = []
  const startDay = Math.floor(t0 / 864e5)
  const endDay = Math.ceil(t1 / 864e5)
  for (let day = startDay; day <= endDay; day++) {
    for (const m of pts) {
      const t = day * 864e5 + m * 60_000
      if (t >= t0 && t <= t1) out.push(t)
    }
  }
  return out.sort((a, b) => a - b)
}

/** Retry-until-delivery: inside the expected delivery window, re-poll every
 *  `stepMin` until something actually lands, capped at `maxR`. Trigger is
 *  "a delivery is expected and has not arrived" -- not "the fetch was empty",
 *  which is a different thing when a feed is between deliveries. */
function retryFetches(base: number[], publishes: number[], density: number[], stepMin: number, maxR: number, insureEveryMin = 0, replaceBase = false): number[] {
  const out: number[] = []
  const pub = [...publishes].sort((a, b) => a - b)
  // Expected delivery window: the contiguous region holding ~90% of the mass.
  const total = density.reduce((a, b) => a + b, 0)
  const BINS = density.length
  const BIN = MINUTES_PER_DAY / BINS
  let best: [number, number] = [0, MINUTES_PER_DAY]
  let bestLen = Infinity
  for (let s = 0; s < BINS; s++) {
    let m = 0
    for (let k = 0; k < BINS; k++) m += density[(s + k) % BINS] as number
    let acc = 0
    let span = 0
    for (let k = 0; k < BINS; k++) {
      acc += density[(s + k) % BINS] as number
      span = (k + 1) * BIN
      if (acc >= 0.9 * total) break
    }
    if (span < bestLen) { bestLen = span; best = [s * BIN, s * BIN + span] }
  }
  const [w0m, w1m] = best
  // Only retry where the density is genuinely concentrated. A flat feed has a
  // window spanning most of the day -- there is no "expected delivery" to wait
  // for there, so retries would be pure waste.
  if (bestLen > 6 * 60) {
    // Flat feed: no "expected delivery" to wait for, so no retries. Insurance
    // still applies -- an out-of-window publish can happen to any feed.
    for (const t of base) out.push(t)
    if (insureEveryMin > 0) {
      const a = base.reduce((x, y) => Math.min(x, y), Infinity)
      const b = base.reduce((x, y) => Math.max(x, y), -Infinity)
      for (let t = a; t <= b; t += insureEveryMin * 60_000) out.push(t)
    }
    return out.sort((x, y) => x - y)
  }
  // Keep going past the END of the window, not just its start: the delivery
  // lands at the end, and drift pushes it further. Cap covers window + 60min.
  const retries = Math.ceil((bestLen + 60) / stepMin)
  const dayOf = (t: number) => Math.floor(t / 864e5)
  const baseDays = new Set(base.map(dayOf))
  for (const day of baseDays) {
    const w0 = day * 864e5 + w0m * 60_000
    for (let k = 0; k <= retries; k++) {
      const t = w0 + k * stepMin * 60_000
      out.push(t)
      // stop as soon as something has actually landed in this delivery window
      if (pub.some((p) => p >= w0 - 30 * 60_000 && p <= t)) break
    }
  }
  // Retries are ADDITIVE by default. With replaceBase, a base poll INSIDE the
  // delivery window is dropped -- the retry chain already covers it -- so the
  // cost is a substitution rather than a second schedule.
  const inWindow = (t: number) => {
    const m = minuteOfDay(t)
    return w0m <= w1m ? m >= w0m && m <= w1m : m >= w0m || m <= w1m
  }
  for (const t of base) if (!replaceBase || !inWindow(t)) out.push(t)
  // Insurance: evenly spaced polls for publishes at an hour the feed has never
  // used. These are the ones retries cannot see by construction.
  if (insureEveryMin > 0) {
    const t0 = base.reduce((a, b) => Math.min(a, b), Infinity)
    const t1 = base.reduce((a, b) => Math.max(a, b), -Infinity)
    for (let t = t0; t <= t1; t += insureEveryMin * 60_000) out.push(t)
  }
  return out.sort((a, b) => a - b)
}

/** Rate model at a FIXED daily budget: `budgetPerDay` expected fetches per day,
 *  split so `zoneShare` of them follow the learned publish density (lagged) and
 *  the rest spread uniformly as insurance. Integrating over a day gives exactly
 *  `budgetPerDay` -- so traffic is identical to the deterministic scheduler and
 *  the only difference is WHERE the budget is spent in time. */
function makeRate(density: number[], opts: { budgetPerDay: number; zoneShare: number; lagMin: number }) {
  const integral = density.reduce((a, b) => a + b, 0) * BIN // = items/day
  return (ts: number): number => {
    const m = ((minuteOfDay(ts) - opts.lagMin) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY
    const idx = Math.floor(m / BIN)
    const p = integral > 0 ? (density[idx] as number) / integral : 0 // PDF over the day
    return opts.budgetPerDay * (opts.zoneShare * p + (1 - opts.zoneShare) / MINUTES_PER_DAY)
  }
}

type CapFn = (now: number, lastFetch: number, ctx: CapCtx) => number
type CapCtx = { medianGapMin: number; itemsPerDay: number; zoneTight: boolean }

/** Non-homogeneous Poisson via a per-minute hazard, optionally capped. */
function poissonFetches(
  mu: (ts: number) => number,
  cap: CapFn,
  ctx: CapCtx,
  t0: number,
  t1: number,
  seed: number,
): number[] {
  let rng = seed
  const rand = () => {
    // xorshift32: deterministic, so runs are reproducible
    rng ^= rng << 13
    rng ^= rng >>> 17
    rng ^= rng << 5
    return ((rng >>> 0) % 1_000_000) / 1_000_000
  }
  const out: number[] = []
  let last = t0
  for (let t = t0; t <= t1; t += 60_000) {
    const limitMin = cap(t, last, ctx)
    if (limitMin > 0 && t - last >= limitMin * 60_000) {
      out.push(t)
      last = t
      continue
    }
    const hazard = mu(t) // expected fetches this minute
    if (rand() < 1 - Math.exp(-hazard)) {
      out.push(t)
      last = t
    }
  }
  return out
}

/** Fraction of stamps outside the smallest window holding ~90% of the mass. */
function outsideFrac(density: number[], stamps: number[]): number {
  const BINS = density.length
  const BIN = MINUTES_PER_DAY / BINS
  const total = density.reduce((a, b) => a + b, 0)
  let bestLen = Infinity
  let bestStart = 0
  for (let s = 0; s < BINS; s++) {
    let acc = 0
    let span = 0
    for (let k = 0; k < BINS; k++) {
      acc += density[(s + k) % BINS] as number
      span = (k + 1) * BIN
      if (acc >= 0.9 * total) break
    }
    if (span < bestLen) { bestLen = span; bestStart = s * BIN }
  }
  const inWin = (m: number) => ((m - bestStart + MINUTES_PER_DAY) % MINUTES_PER_DAY) <= bestLen
  const out = stamps.filter((m) => !inWin(m)).length
  return stamps.length ? out / stamps.length : 0
}

// ---------- measurement ----------

function measure(fetches: number[], publishes: number[]) {
  if (!fetches.length) return { lat: [] as number[], misses: publishes.length }
  const sorted = [...fetches].sort((a, b) => a - b)
  const lat: number[] = []
  let misses = 0
  for (const p of publishes) {
    // binary search for the first fetch at or after p
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((sorted[mid] as number) < p) lo = mid + 1
      else hi = mid
    }
    if (lo >= sorted.length) misses++
    else lat.push(((sorted[lo] as number) - p) / 60_000)
  }
  return { lat, misses }
}

function stats(lat: number[]) {
  if (!lat.length) return { p50: 0, p90: 0, p99: 0, max: 0, n: 0 }
  const s = [...lat].sort((a, b) => a - b)
  return {
    p50: quantile(s, 0.5),
    p90: quantile(s, 0.9),
    p99: quantile(s, 0.99),
    max: s[s.length - 1] as number,
    n: s.length,
  }
}

// ---------- main ----------

const trace = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as Trace
console.log(`trace: ${trace.length} feeds, ${trace.reduce((n, f) => n + f.publishedAt.length, 0)} publishes\n`)

const TIGHT = 15 // minutes: the publish-zone cap we want for a bedtime deadline
const CAP_MIN = 15
const CAP_MAX = 720

const caps: Record<string, CapFn> = {
  'none': () => 0,
  'flat:60': () => 60,
  'flat:15': () => TIGHT,
  // "a factor based on frequency": never let more than 1/8 of a publish cycle
  // pass unfetched, clamped to [15min, 12h].
  'cadence:gap/8': (_n, _l, c) => Math.min(CAP_MAX, Math.max(CAP_MIN, c.medianGapMin / 8)),
  // volume: feeds that publish more at once are allowed a slightly looser cap,
  // because the items arrive in batches rather than needing per-item freshness.
  'volume': (_n, _l, c) => Math.min(CAP_MAX, Math.max(CAP_MIN, 30 * (1 + Math.log1p(c.itemsPerDay)))),
}

const perFeed: Record<string, { lat: number[]; fetches: number; byHost: Map<string, number> }> = {}
for (const k of ['current', 'selective', 'selective+ins2h', 'replace+retry', 'replace+ins4h', 'replace+ins2h', 'retry:5m x8', 'retry:10m x6', 'retry:15m x4', 'retry+ins2h', 'retry+ins4h', 'retry+ins6h', 'knob:tail2', 'tail2+retry10', 'tail2+retry5x12', 'knob:tail', 'fixed:z0.6', 'fixed:z0.8', 'fixed:z1', 'poisson', 'poisson+zone', 'zone+hard30', 'zone+hard60', 'zone+hard120',
  ...Object.keys(caps).map((c) => `poisson+${c}`)]) {
  perFeed[k] = { lat: [], fetches: 0, byHost: new Map() }
}

const spotlight = trace.find((f) => /questionable/i.test(f.title))
const spotlightBy: Record<string, number[]> = {}

/** Raw fetch events per strategy, for host-level politeness thinning. */
const globalFetches: Record<string, { host: string; feed: string; t: number }[]> = {}
const globalPublishes: { host: string; feed: string; t: number }[] = []
const feedSpan = new Map<string, number>()

for (const feed of trace) {
  const all = [...feed.publishedAt].sort((a, b) => a - b)
  if (all.length < 8) continue
  const split = Math.floor(all.length * 0.7)
  const train = all.slice(0, split)
  const test = all.slice(split)
  // Start the schedule 2 days before the first test publish: otherwise the
  // first test day's poll can fall before t0 and be dropped, and its publishes
  // show a 24h latency that is an artifact of the window edge, not the policy.
  const t0 = (test[0] as number) - 2 * 864e5
  const t1 = (test[test.length - 1] as number) + 6 * 3600e3

  const trainDays = Math.max(1, ((train[train.length - 1] as number) - (train[0] as number)) / 864e5)
  const mins = train.map(minuteOfDay)
  const density = learnDensity(mins, trainDays)

  const gaps: number[] = []
  for (let i = 1; i < train.length; i++) gaps.push(((train[i] as number) - (train[i - 1] as number)) / 60_000)
  const ctx: CapCtx = {
    medianGapMin: median(gaps) || 1440,
    itemsPerDay: train.length / Math.max(1, trainDays),
    zoneTight: true,
  }

  const budgetPerDay = Math.max(1, Math.ceil(mins.length / Math.max(1, trainDays)))
  // Same budget as the deterministic scheduler, just redistributed in time.
  const rates = new Map<number, (ts: number) => number>()
  for (const z of [0.6, 0.8, 1.0]) rates.set(z, makeRate(density, { budgetPerDay, zoneShare: z, lagMin: 10 }))
  const mu = rates.get(0.8) as (ts: number) => number

  const run = (label: string, fetches: number[]) => {
    const { lat } = measure(fetches, test)
    if (feed === spotlight) spotlightBy[label] = lat
    const d = perFeed[label]
    if (!d) return lat
    d.lat.push(...lat)
    const days = Math.max(1, (t1 - t0) / 864e5)
    d.fetches += fetches.length / days
    d.byHost.set(feed.host, (d.byHost.get(feed.host) ?? 0) + fetches.length / days)
    for (const f of fetches) (globalFetches[label] ??= []).push({ host: feed.host, feed: feed.id, t: f })
    return lat
  }
  feedSpan.set(feed.id, Math.max(1, (t1 - t0) / 864e5))
  for (const p of test) globalPublishes.push({ host: feed.host, feed: feed.id, t: p })

  run('current', currentFetches(mins, trainDays, t0, t1))
  const base = currentFetches(mins, trainDays, t0, t1)
  run('retry:5m x8', retryFetches(base, test, density, 5, 8))
  run('retry:10m x6', retryFetches(base, test, density, 10, 6))
  run('retry:15m x4', retryFetches(base, test, density, 15, 4))
  run('knob:tail2', currentFetches(mins, trainDays, t0, t1, 'tail2'))
  run('tail2+retry10', retryFetches(currentFetches(mins, trainDays, t0, t1, 'tail2'), test, density, 10, 6))
  run('tail2+retry5x12', retryFetches(currentFetches(mins, trainDays, t0, t1, 'tail2'), test, density, 5, 12))
  run('retry+ins2h', retryFetches(base, test, density, 10, 6, 120))
  run('retry+ins4h', retryFetches(base, test, density, 10, 6, 240))
  run('retry+ins6h', retryFetches(base, test, density, 10, 6, 360))
  run('replace+retry', retryFetches(base, test, density, 10, 6, 0, true))
  run('replace+ins4h', retryFetches(base, test, density, 10, 6, 240, true))
  run('replace+ins2h', retryFetches(base, test, density, 10, 6, 120, true))
  // Selective insurance: only cover feeds that have actually gone off-schedule.
  // One conditional on a number the histogram already yields.
  const off = outsideFrac(density, mins)
  run('selective', retryFetches(
    currentFetches(mins, trainDays, t0, t1, 'tail2'), test, density, 10, 6,
    off > 0.05 ? 240 : 0, true,
  ))
  run('selective+ins2h', retryFetches(
    currentFetches(mins, trainDays, t0, t1, 'tail2'), test, density, 10, 6,
    off > 0.05 ? 120 : 0, true,
  ))
  run('poisson', poissonFetches(mu, () => 0, ctx, t0, t1, 12345))
  for (const z of [0.6, 0.8, 1.0]) {
    run(`fixed:z${z}`, poissonFetches(rates.get(z) as (ts: number) => number, () => 0, ctx, t0, t1, 12345))
  }

  // The zone cap needs this feed's own density: tight through the publish
  // window, cadence-scaled everywhere else.
  const maxD = Math.max(...density)
  const zoneFn: CapFn = (now, _last, c) =>
    (density[Math.floor(minuteOfDay(now) / BIN)] as number) > 0.25 * maxD
      ? TIGHT
      : Math.min(CAP_MAX, Math.max(CAP_MIN, c.medianGapMin / 8))
  const zoneLat = run('poisson+zone', poissonFetches(mu, zoneFn, ctx, t0, t1, 12345))
  if (feed === spotlight) spotlightBy['poisson+zone'] = zoneLat

  // The combination worth measuring: tight through the publish zone, and a
  // HARD ceiling everywhere else so max latency is bounded outright.
  for (const hard of [30, 60, 120]) {
    const fn: CapFn = (now, _l, c) =>
      (density[Math.floor(minuteOfDay(now) / BIN)] as number) > 0.25 * maxD
        ? TIGHT
        : hard
    run(`zone+hard${hard}`, poissonFetches(mu, fn, ctx, t0, t1, 12345))
  }

  for (const [name, fn] of Object.entries(caps)) {
    run(`poisson+${name}`, poissonFetches(mu, fn, ctx, t0, t1, 12345))
  }
}


const row = (label: string) => {
  const d = perFeed[label]
  if (!d) return
  const s = stats(d.lat)
  // busiest host: requests per day, and the resulting minimum gap between them
  let host = ''
  let hostMax = 0
  for (const [h, n] of d.byHost) if (n > hostMax) { hostMax = n; host = h }
  const gapMin = hostMax > 0 ? 1440 / hostMax : 0
  console.log(
    `  ${label.padEnd(24)} ${s.n.toString().padStart(6)}  ` +
      `${s.p50.toFixed(0).padStart(6)} ${s.p90.toFixed(0).padStart(6)} ` +
      `${s.p99.toFixed(0).padStart(6)} ${s.max.toFixed(0).padStart(6)}   ` +
      `${d.fetches.toFixed(0).padStart(6)}  ${hostMax.toFixed(0).padStart(5)}/d = 1 per ${gapMin.toFixed(0)}m`,
  )
}

console.log('=== ALL FEEDS: latency minutes (learned on first 70%, measured on last 30%) ===')
console.log(`  ${'strategy'.padEnd(24)} ${'n'.padStart(6)}  ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(6)}   ${'f/day'.padStart(6)}  busiest host`)
for (const k of Object.keys(perFeed)) row(k)

// ---------- the real constraint: per-host politeness ----------
// Politeness is per host, not global. Thin every strategy to a host-wide
// minimum gap and re-measure: this is what a busy host actually forces on us.
function hostCapped(label: string, gapMs: number) {
  // Thin per HOST (the politeness budget is shared), but measure per FEED -- a
  // fetch of feed B never delivers feed A's items even on the same host.
  const byHost = new Map<string, { feed: string; t: number }[]>()
  for (const e of globalFetches[label] ?? []) {
    const a = byHost.get(e.host) ?? []
    a.push(e)
    byHost.set(e.host, a)
  }
  const keptPerFeed = new Map<string, number[]>()
  let keptTotal = 0
  for (const arr of byHost.values()) {
    arr.sort((x, y) => x.t - y.t)
    let last = -Infinity
    for (const e of arr) {
      if (e.t - last >= gapMs) {
        const a = keptPerFeed.get(e.feed) ?? []
        a.push(e.t)
        keptPerFeed.set(e.feed, a)
        last = e.t
        keptTotal++
      }
    }
  }
  const pubPerFeed = new Map<string, number[]>()
  for (const p of globalPublishes) {
    const a = pubPerFeed.get(p.feed) ?? []
    a.push(p.t)
    pubPerFeed.set(p.feed, a)
  }
  const lat: number[] = []
  for (const [feed, arr] of pubPerFeed) lat.push(...measure(keptPerFeed.get(feed) ?? [], arr).lat)
  let perDay = 0
  for (const [feed, arr] of keptPerFeed) perDay += arr.length / (feedSpan.get(feed) ?? 1)
  return { s: stats(lat), perDay }
}

console.log('\n=== host-wide minimum gap enforced (politeness budget) ===')
console.log(`  ${'host gap'.padEnd(12)} ${'strategy'.padEnd(16)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(6)}   ${'f/day'.padStart(6)}`)
for (const gap of [0, 30, 60, 120, 300]) {
  for (const label of ['current', 'poisson+flat:60', 'zone+hard30', 'zone+hard60']) {
    const { s, perDay } = hostCapped(label, gap * 1000)
    console.log(
      `  ${(`1 per ${gap}s`).padEnd(12)} ${label.padEnd(16)} ` +
        `${s.p50.toFixed(0).padStart(6)} ${s.p90.toFixed(0).padStart(6)} ` +
        `${s.p99.toFixed(0).padStart(6)} ${s.max.toFixed(0).padStart(6)}   ${perDay.toFixed(0).padStart(6)}`,
    )
  }
  console.log('')
}

if (spotlight) {
  console.log(`\n=== ${spotlight.title}: latency minutes ===`)
  console.log(`  ${'strategy'.padEnd(20)} ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(6)}`)
  for (const [label, l] of Object.entries(spotlightBy)) {
    const s = stats(l)
    console.log(`  ${label.padEnd(20)} ${s.p50.toFixed(0).padStart(6)} ${s.p90.toFixed(0).padStart(6)} ${s.p99.toFixed(0).padStart(6)} ${s.max.toFixed(0).padStart(6)}`)
  }
  console.log(`\n  worst 5 for retry+ins2h -- publish vs first fetch:`)
  const ev = (globalFetches['retry+ins2h'] ?? []).filter((e) => e.feed === spotlight.id).map((e) => e.t).sort((a, b) => a - b)
  const pubs = globalPublishes.filter((p) => p.feed === spotlight.id).map((p) => p.t).sort((a, b) => a - b)
  const rows = pubs.map((p) => {
    const f = ev.find((t) => t >= p)
    return { pub: p, lat: f == null ? Infinity : (f - p) / 60000 }
  }).sort((a, b) => b.lat - a.lat).slice(0, 5)
  for (const r of rows)
    console.log(`   ${new Date(r.pub).toISOString().slice(0, 16)}  +${r.lat.toFixed(0)}m  fetch=${r.lat === Infinity ? 'NONE' : new Date(r.pub + r.lat * 60000).toISOString().slice(11, 16)}`)
  console.log(`  fetch count for QC in retry+ins2h: ${ev.length}`)
  const probe = Date.parse('2026-06-24T10:28:00Z')
  const near = ev.filter((t) => Math.abs(t - probe) < 20 * 3600e3).map((t) => new Date(t).toISOString().slice(5, 16))
  console.log(`  fetches within 20h of that publish (${near.length}):`, near.slice(0, 24).join(' '))
}
