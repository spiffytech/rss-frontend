/**
 * Coverage audit: does the SCHEDULE actually cover when feeds publish?
 *
 *   bun playground/scripts/coverage-audit.ts <trace.json>
 *
 * For each feed, learn the model from the first 70% of its publishes using the
 * REAL buildFeedModel, generate the poll instants that model would schedule, and
 * measure every held-out publish's distance to the next poll. That distance IS
 * the latency the reader would see -- so this is the scoreboard, measured rather
 * than asserted.
 */
import { readFileSync } from 'node:fs'
import {
  buildFeedModel,
  epochDay,
  MINUTES_PER_DAY,
  type FeedInput,
} from '../../app/src/server/scheduler/model'

const OPTS = {
  entryFrequencyFactor: 1,
  maxPollsPerDay: 288, // 1440 / SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL(5)
  learningWindowDays: 90,
  rateHalfLifeDays: 7,
}

type Trace = { id: string; title: string; host: string; publishedAt: number[] }[]
const trace = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as Trace

const MS_DAY = 86_400_000
const minuteOfDay = (ts: number) => Math.floor(ts / 60_000) % MINUTES_PER_DAY
const median = (xs: number[]) => (xs.length ? (xs[Math.floor(xs.length / 2)] as number) : 0)
const quantile = (sorted: number[], p: number) =>
  sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number) : 0

function toInput(publishes: number[]): FeedInput {
  const stamps = publishes.map(minuteOfDay)
  const dayCounts = new Map<number, number>()
  for (const p of publishes) {
    const d = epochDay(p)
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1)
  }
  const gaps: number[] = []
  for (let i = 1; i < publishes.length; i++) gaps.push(((publishes[i] as number) - (publishes[i - 1] as number)) / 60_000)
  const sorted = [...gaps].sort((a, b) => a - b)
  return {
    feedId: 'audit' as never,
    stamps,
    dayCounts,
    medGapMinutes: sorted.length ? median(sorted) : null,
  }
}

/** All poll instants the model would schedule over [from, to]. */
function pollInstants(model: NonNullable<ReturnType<typeof buildFeedModel>>, from: number, to: number): number[] {
  const out: number[] = []
  const startDay = Math.floor(from / MS_DAY)
  const endDay = Math.ceil(to / MS_DAY)
  for (let d = startDay; d <= endDay; d++) {
    const dayStart = d * MS_DAY
    const dow = new Date(dayStart).getUTCDay()
    for (const m of model.pollMinutes(dow)) {
      const t = dayStart + m * 60_000
      if (t >= from && t <= to) out.push(t)
    }
  }
  return out.sort((a, b) => a - b)
}

interface Row {
  title: string
  n: number
  p50: number
  p90: number
  max: number
  worstAt: number
  supportMin: number
  supportMax: number
}

const rows: Row[] = []
const all: number[] = []

for (const feed of trace) {
  const all0 = [...feed.publishedAt].sort((a, b) => a - b)
  if (all0.length < 8) continue
  const split = Math.floor(all0.length * 0.7)
  const train = all0.slice(0, split)
  const audit = all0.slice(split)
  const input = toInput(train)
  const model = buildFeedModel(input, OPTS)
  if (!model) continue

  const from = (audit[0] as number) - 2 * MS_DAY
  const to = (audit[audit.length - 1] as number) + 2 * MS_DAY
  const polls = pollInstants(model, from, to)

  const lat: number[] = []
  let worstAt = 0
  let worst = -1
  for (const p of audit) {
    let lo = 0
    let hi = polls.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((polls[mid] as number) < p) lo = mid + 1
      else hi = mid
    }
    if (lo >= polls.length) continue
    const m = ((polls[lo] as number) - p) / 60_000
    lat.push(m)
    if (m > worst) {
      worst = m
      worstAt = p
    }
  }
  if (!lat.length) continue
  lat.sort((a, b) => a - b)
  all.push(...lat)
  const mins = train.map(minuteOfDay)
  rows.push({
    title: feed.title,
    n: lat.length,
    p50: quantile(lat, 0.5),
    p90: quantile(lat, 0.9),
    max: lat[lat.length - 1] as number,
    worstAt,
    supportMin: Math.min(...mins),
    supportMax: Math.max(...mins),
  })
}

all.sort((a, b) => a - b)
console.log(`=== coverage: publish -> next scheduled poll, minutes (held-out 30%) ===`)
console.log(`feeds=${rows.length}  publishes=${all.length}`)
console.log(
  `p50=${quantile(all, 0.5).toFixed(0)}  p90=${quantile(all, 0.9).toFixed(0)}  ` +
    `p99=${quantile(all, 0.99).toFixed(0)}  max=${(all[all.length - 1] ?? 0).toFixed(0)}`,
)

const hhmm = (min: number) => {
  const m = ((min % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

console.log(`\n=== worst 20 feeds by p90 ===`)
console.log(`  ${'p50'.padStart(6)} ${'p90'.padStart(6)} ${'max'.padStart(6)}  ${'window'.padEnd(13)}  feed`)
for (const r of [...rows].sort((a, b) => b.p90 - a.p90).slice(0, 20)) {
  console.log(
    `  ${r.p50.toFixed(0).padStart(6)} ${r.p90.toFixed(0).padStart(6)} ${r.max.toFixed(0).padStart(6)}  ` +
      `${(hhmm(r.supportMin) + '-' + hhmm(r.supportMax)).padEnd(13)}  ${r.title.slice(0, 34)}`,
  )
}

const qc = rows.find((r) => /questionable/i.test(r.title))
if (qc) {
  console.log(`\n=== ${qc.title} ===`)
  console.log(`  p50=${qc.p50.toFixed(0)} p90=${qc.p90.toFixed(0)} max=${qc.max.toFixed(0)}`)
  console.log(`  observed publish range ${hhmm(qc.supportMin)}-${hhmm(qc.supportMax)} (UTC)`)
  console.log(`  worst publish at ${new Date(qc.worstAt).toISOString().slice(0, 16)}`)
}

const over = (t: number) => rows.filter((r) => r.p90 > t).length
console.log(`\nfeeds whose p90 exceeds the target:`)
for (const t of [30, 60, 120, 240, 720]) console.log(`  > ${String(t).padStart(4)} min : ${over(t)}`)
