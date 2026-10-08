/**
 * Does the EMA item-rate actually beat a flat window average?
 *
 * The existing poll-sim.ts CANNOT answer this: its real-feed replay draws every
 * day from the same fixed per-feed rate (`rf.rate`), so the rate never changes
 * and the two estimators are indistinguishable by construction. This harness
 * therefore generates feeds whose pace moves, and drives the REAL
 * `buildFeedModel` from src/server/lib/schedule/model.ts rather than a copy.
 *
 * The flat baseline is produced through the identical code path: feeding
 * dayCounts with the total spread evenly across the whole window makes the EMA
 * return exactly N/learningWindowDays, which is the old flat formula.
 *
 * Run: bun playground/scripts/ema-latency-sim.ts
 */
import { buildFeedModel, minuteOfDay, type FeedInput, type ScheduleOptions } from '../../src/server/lib/schedule/model'

const LEARN = 90
const TRAIN_DAYS = 90 // history before the measured window
const TEST_DAYS = 30
const HALF_LIFE = 7
const MINUTES_PER_DAY = 1440

/** deterministic PRNG so runs are comparable */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Cohort = {
  name: string
  /** items/day as a function of day index, 0-based over the whole run */
  rate: (day: number) => number
  /** minute-of-day sampler */
  at: (rnd: () => number, day: number) => number
}

const gaussian = (rnd: () => number) => {
  const u = Math.max(rnd(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd())
}

const COHORTS: Cohort[] = [
  {
    name: 'steady 20/day',
    rate: () => 20,
    at: (rnd) => (21 * 60 + gaussian(rnd) * 90 + 1440) % 1440,
  },
  {
    name: 'accelerating 3 -> 30/day',
    rate: (d) => (d < TRAIN_DAYS ? 3 : 3 + Math.min(1, (d - TRAIN_DAYS) / 10) * 27),
    at: (rnd) => (21 * 60 + gaussian(rnd) * 120 + 1440) % 1440,
  },
  {
    name: 'decelerating 30 -> 3/day',
    rate: (d) => (d < TRAIN_DAYS ? 30 : 30 - Math.min(1, (d - TRAIN_DAYS) / 10) * 27),
    at: (rnd) => (21 * 60 + gaussian(rnd) * 120 + 1440) % 1440,
  },
  {
    name: 'spike: 2/day + 40 on day 5 of test',
    rate: (d) => (d === TRAIN_DAYS + 5 ? 42 : 2),
    at: (rnd) => (12 * 60 + gaussian(rnd) * 300 + 1440) % 1440,
  },
  {
    name: 'smeared 12/day over 20h',
    rate: () => 12,
    at: (rnd) => rnd() * MINUTES_PER_DAY,
  },
]

type Ev = { absDay: number; minute: number }

function genEvents(c: Cohort, days: number, rnd: () => number): Ev[] {
  const out: Ev[] = []
  for (let d = 0; d < days; d++) {
    const r = c.rate(d)
    const n = Math.floor(r) + (rnd() < r % 1 ? 1 : 0)
    for (let i = 0; i < n; i++) out.push({ absDay: d, minute: Math.floor(c.at(rnd, d)) })
  }
  return out
}

/** FeedInput over [fromDay, toDay] from the event stream. */
function inputFor(events: Ev[], fromDay: number, toDay: number, flat: boolean): FeedInput {
  const inWindow = events.filter((e) => e.absDay >= fromDay && e.absDay <= toDay)
  const dayCounts = new Map<number, number>()
  for (const e of inWindow) dayCounts.set(e.absDay, (dayCounts.get(e.absDay) ?? 0) + 1)

  let window: Map<number, number>
  if (flat) {
    // Spread the total evenly: the EMA then returns exactly N/LEARN, which is
    // the old flat formula, while `stamps` still carries the true shape.
    window = new Map<number, number>()
    const total = inWindow.length
    for (let d = fromDay; d <= toDay; d++) window.set(d, total / (toDay - fromDay + 1))
  } else {
    window = dayCounts
  }

  return {
    feedId: 1,
    stamps: inWindow.map((e) => e.minute),
    dayCounts: window,
    medGapMinutes: 60,
  }
}

const OPTS = (nowEpochDay: number, halfLifeDays: number): ScheduleOptions => ({
  entryFrequencyFactor: 1,
  maxPollsPerDay: 288,
  learningWindowDays: LEARN,
  rateHalfLifeDays: halfLifeDays,
  nowEpochDay,
})

function run(c: Cohort, flat: boolean, seed: number) {
  const rnd = mulberry32(seed)
  const totalDays = TRAIN_DAYS + TEST_DAYS
  const events = genEvents(c, totalDays, rnd)

  const latencies: number[] = []
  let polls = 0
  let caught = 0

  for (let d = TRAIN_DAYS; d < totalDays; d++) {
    const model = buildFeedModel(inputFor(events, Math.max(0, d - LEARN + 1), d, flat), OPTS(d, HALF_LIFE))
    const todays = events.filter((e) => e.absDay === d)
    if (!model) continue

    const dow = new Date(d * 86400000).getUTCDay()
    const pollTimes = model.pollMinutes(dow).map((m) => d * MINUTES_PER_DAY + m).sort((a, b) => a - b)
    polls += pollTimes.length

    for (const p of pollTimes) {
      for (const e of todays) {
        const t = e.absDay * MINUTES_PER_DAY + e.minute
        if (t <= p && !done.has(e)) {
          done.add(e)
          latencies.push(p - t)
          caught++
        }
      }
    }
  }

  const missed = events.filter((e) => e.absDay >= TRAIN_DAYS && !done.has(e)).length
  done.clear()
  latencies.sort((a, b) => a - b)
  const q = (x: number) => latencies[Math.min(latencies.length - 1, Math.floor(x * latencies.length))] ?? 0
  return {
    pollsPerDay: polls / TEST_DAYS,
    caught,
    missed,
    p50: q(0.5),
    p90: q(0.9),
  }
}

const done = new Set<Ev>()

console.log('cohort'.padEnd(36), 'estimator'.padEnd(7), 'polls/d'.padStart(8), 'caught'.padStart(7), 'missed'.padStart(7), 'p50'.padStart(8), 'p90'.padStart(8))
console.log('-'.repeat(92))
for (const c of COHORTS) {
  for (const flat of [false, true]) {
    const r = run(c, flat, 12345)
    console.log(
      c.name.padEnd(36),
      (flat ? 'flat' : 'EMA').padEnd(7),
      r.pollsPerDay.toFixed(1).padStart(8),
      String(r.caught).padStart(7),
      String(r.missed).padStart(7),
      `${(r.p50 / 60).toFixed(1)}h`.padStart(8),
      `${(r.p90 / 60).toFixed(1)}h`.padStart(8),
    )
  }
  console.log('')
}
