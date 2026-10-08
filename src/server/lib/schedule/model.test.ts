/**
 * Unit tests for the scheduling model. These pin the behaviours that the
 * simulator (`playground/scripts/poll-sim.ts`) validated, and in particular the
 * regression that motivated the design: Miniflux's entry_frequency derives a
 * feed's rate from `(max - min) / (count - 1)`, whose denominator collapses
 * when entries cluster. Two entries five minutes apart therefore look like an
 * extremely fast feed and get polled 288x/day. Our budget divides by the
 * learning window instead, so clustering cannot inflate it.
 *
 * Run: bun test src/server/lib/schedule
 */
import { describe, expect, test } from 'bun:test'

import {
  buildFeedModel,
  decodeCacheHintMinutes,
  entryFrequencyIntervalMinutes,
  MINUTES_PER_DAY,
  minuteOfDay,
  type FeedInput,
  type ScheduleOptions,
} from './model'

const OPTS: ScheduleOptions = {
  entryFrequencyFactor: 1,
  maxPollsPerDay: 288,
  learningWindowDays: 90,
  rateHalfLifeDays: 7,
  nowEpochDay: 19089,
}

/** `days` consecutive epoch days starting at 19000. */
const day = (i: number) => 19000 + i

function feed(stamps: number[], dayCounts: Map<number, number>, medGapMinutes: number | null): FeedInput {
  return { feedId: 1, stamps, dayCounts, medGapMinutes }
}

describe('buildFeedModel', () => {
  test('punctual daily feed: one poll at the mode', () => {
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 90; i++) {
      stamps.push(21 * 60) // 21:00 UTC every day
      dayCounts.set(day(i), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts, 24 * 60), OPTS)
    expect(m).not.toBeNull()
    // 90 entries over 7 weekdays => no weekday signal, so budget collapses to
    // N / learningWindowDays = 1 poll/day.
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBe(1)
    const polls = m!.pollMinutes(3)
    expect(polls).toHaveLength(1)
    // one poll sits past the bulk of the mode, i.e. at/near 21:00
    expect(Math.abs(polls[0]! - 21 * 60)).toBeLessThanOrEqual(5)
  })

  test('bimodal feed: two modes are recognised', () => {
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 60; i++) {
      stamps.push(i % 2 === 0 ? 9 * 60 : 21 * 60)
      dayCounts.set(day(i), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts, 24 * 60), OPTS)
    expect(m).not.toBeNull()
    expect(m!.concentrated).toBe(true)
    expect(m!.numModes).toBeGreaterThanOrEqual(2)
  })

  test('two entries five minutes apart yield ONE poll, not 288', () => {
    // The exact shape that made Miniflux poll Framework Blog every 5 minutes.
    const dayCounts = new Map<number, number>([[day(0), 2]])
    const m = buildFeedModel(feed([20 * 60, 20 * 60 + 5], dayCounts, 5), OPTS)
    expect(m).not.toBeNull()
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBe(1)
  })

  test('clustering cannot inflate the budget', () => {
    // 20 entries in a five-minute burst on one day of a 90-day window.
    const stamps = Array.from({ length: 20 }, (_, i) => 20 * 60 + i)
    const dayCounts = new Map<number, number>([[day(0), 20]])
    const m = buildFeedModel(feed(stamps, dayCounts, 1), OPTS)
    expect(m).not.toBeNull()
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeLessThanOrEqual(2)
  })

  test('date-only feed: uniform placement with a floor of three', () => {
    const stamps = Array.from({ length: 30 }, () => 0) // every entry stamped midnight
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 1)
    const m = buildFeedModel(feed(stamps, dayCounts, 24 * 60), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dateOnly).toBe(true)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeGreaterThanOrEqual(3)
    expect(m!.pollMinutes(3)).toEqual([240, 720, 1200])
  })

  test('weekday signal concentrates the budget on publish days', () => {
    // Publishes only on Tuesdays (epoch days 19000..: 19000 % 7 === 3, so use a
    // step of 7 to keep the weekday fixed).
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 13; i++) {
      stamps.push(10 * 60)
      dayCounts.set(day(i * 7), 1)
    }
    const m = buildFeedModel(feed(stamps, dayCounts, 7 * 24 * 60), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dowSignal).toBe(true)
    const publishDow = new Date(19000 * 86400_000).getUTCDay()
    expect(m!.budget[publishDow]).toBe(1)
    // Non-publish days fall back to the 1/day floor rather than being starved.
    for (let d = 0; d < 7; d++) {
      if (d !== publishDow) expect(m!.budget[d]).toBe(1)
    }
  })

  test('a feed that posts every day keeps its full budget on every day', () => {
    // Regression: the weekday gate used a fixed 0.12 share, and a daily feed
    // sits at ~1/7 = 0.143 per weekday. Sampling noise that dropped one weekday
    // below 0.12 flipped dowSignal on and gave that weekday a budget of 1,
    // turning Hacker News (65 items/day) into a once-a-day feed.
    const stamps: number[] = []
    const dayCounts = new Map<number, number>()
    let n = 0
    for (let i = 0; i < 90; i++) {
      // 63 items/day, but deliberately uneven across weekdays (one weekday gets
      // only 8 active days out of 90).
      const dow = new Date(day(i) * 86400_000).getUTCDay()
      // Wednesday is merely uneven (about 10 active days out of 90), not absent.
      if (dow === 3 && i % 4 === 0) continue
      const items = 63
      for (let k = 0; k < items; k++) stamps.push(Math.floor((k * MINUTES_PER_DAY) / items))
      dayCounts.set(day(i), items)
      n += items
    }
    expect(n).toBeGreaterThan(4000)
    const m = buildFeedModel(feed(stamps, dayCounts, 20), OPTS)
    expect(m).not.toBeNull()
    expect(m!.dowSignal).toBe(false)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeGreaterThanOrEqual(50)
  })

  test('no entries yields no model', () => {
    expect(buildFeedModel(feed([], new Map(), null), OPTS)).toBeNull()
  })
})

describe('rate EMA', () => {
  test('follows a feed that accelerates — a flat window average could not', () => {
    // Quiet at 4/day for 80 days, then 30/day for the last 10.
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 80; i++) dayCounts.set(day(i), 4)
    for (let i = 80; i < 90; i++) dayCounts.set(day(i), 30)
    const stamps = new Array<number>(620).fill(12 * 60)
    const m = buildFeedModel(feed(stamps, dayCounts, 60), OPTS)
    expect(m).not.toBeNull()
    // Flat average would be (80*4 + 10*30)/90 = 6.2/day. The EMA is dominated by
    // the recent 30/day and lands near 20 — the budget has to follow the pace
    // or the items published today sit unread for hours.
    expect(m!.budget[0]).toBeGreaterThan(15)
  })

  test('clustering cannot inflate the rate (the mean-gap pathology)', () => {
    // Two entries five minutes apart on ONE day. Miniflux's
    // (max-min)/(count-1) denominator collapses and yields 288 items/day.
    const dayCounts = new Map<number, number>([[day(89), 2]])
    const m = buildFeedModel(feed([600, 605], dayCounts, 5), OPTS)
    expect(m).not.toBeNull()
    expect(Math.max(...m!.budget)).toBeLessThanOrEqual(3)
  })

  test('a steady feed reports exactly its rate, for any half-life', () => {
    // Guards the truncated-tail normalisation: without it a constant rate r
    // reads as r*(1 - decay^learnDays) and silently understates the budget.
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 90; i++) dayCounts.set(day(i), 20)
    const stamps = new Array<number>(1800).fill(12 * 60)
    for (const hl of [1, 3, 7, 30, 200]) {
      const m = buildFeedModel(feed(stamps, dayCounts, 60), { ...OPTS, rateHalfLifeDays: hl })
      expect(m).not.toBeNull()
      expect(m!.budget[0]).toBe(20)
    }
  })

  test('a feed that goes quiet decays back to the floor', () => {
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 40) // busy month…
    // …then nothing for the last 60 days
    const stamps = new Array<number>(1200).fill(12 * 60)
    const m = buildFeedModel(feed(stamps, dayCounts, 60), OPTS)
    expect(m).not.toBeNull()
    expect(m!.budget[0]).toBe(1)
  })
})

describe('regressions', () => {
  test('minuteOfDay stays in 0..1439 for pre-1970 timestamps', () => {
    // JS `%` keeps the sign of the dividend, so a naive implementation returns
    // -1 here and silently breaks the 0..1439 contract.
    const justBeforeEpoch = Date.UTC(1969, 11, 31, 23, 59, 30)
    expect(minuteOfDay(justBeforeEpoch)).toBe(1439)
    expect(minuteOfDay(-1)).toBe(1439)
    for (const ms of [-1, -60_000, -86_400_000, -123_456_789]) {
      const m = minuteOfDay(ms)
      expect(m).toBeGreaterThanOrEqual(0)
      expect(m).toBeLessThan(MINUTES_PER_DAY)
    }
  })

  test('date-only budget never exceeds maxPollsPerDay, even when it is below 3', () => {
    // clamp(x, 3, 2) used to return 3 and poll MORE than the configured max.
    const stamps = new Array<number>(30).fill(0) // date-only: all midnight
    const dayCounts = new Map<number, number>()
    for (let i = 0; i < 30; i++) dayCounts.set(day(i), 1)
    const opts: ScheduleOptions = { ...OPTS, maxPollsPerDay: 2 }
    const m = buildFeedModel(feed(stamps, dayCounts, 1440), opts)
    expect(m).not.toBeNull()
    expect(m!.dateOnly).toBe(true)
    for (let d = 0; d < 7; d++) expect(m!.budget[d]).toBeLessThanOrEqual(2)
  })
})

describe('cache-hint decode', () => {
  // Mirrors Miniflux's ScheduleNextCheck: interval = min(max(entryInterval,
  // refreshDelay), maxInterval). The decoder must invert this exactly.
  const minifluxWrites = (
    weeklyCount: number,
    refreshDelayMin: number,
    factor = 1,
    minI = 5,
    maxI = 1440,
  ): number => {
    const entry = entryFrequencyIntervalMinutes(weeklyCount, factor, minI, maxI)
    return Math.min(Math.max(entry, refreshDelayMin), maxI)
  }

  test('entry-frequency interval matches Miniflux, including the zero-count case', () => {
    // 397 items/week -> 10080/397 = 25.4 min
    expect(entryFrequencyIntervalMinutes(397, 1, 5, 1440)).toBeCloseTo(25.4, 1)
    // No entries -> max interval, not divide-by-zero.
    expect(entryFrequencyIntervalMinutes(0, 1, 5, 1440)).toBe(1440)
    // One entry -> Miniflux returns 0 from WeeklyFeedEntryCount -> max interval.
    expect(entryFrequencyIntervalMinutes(0, 1, 5, 1440)).toBe(1440)
    // Clamped at both ends.
    expect(entryFrequencyIntervalMinutes(100000, 1, 5, 1440)).toBe(5)
    expect(entryFrequencyIntervalMinutes(1, 1, 5, 1440)).toBe(1440)
  })

  test('round-trips a Retry-After hint through Miniflux\'s write formula', () => {
    // A 429 with Retry-After: 120 min, on a feed that publishes 397/week
    // (entry interval ~25 min). Miniflux writes max(25.4, 120) = 120.
    const observed = minifluxWrites(397, 120)
    expect(observed).toBe(120)
    const entry = entryFrequencyIntervalMinutes(397, 1, 5, 1440)
    expect(decodeCacheHintMinutes(observed, entry)).toBeCloseTo(120 - 25.4, 1)
  })

  test('reports no hint when entry frequency alone explains the interval', () => {
    const observed = minifluxWrites(397, 0) // no cache headers at all
    const entry = entryFrequencyIntervalMinutes(397, 1, 5, 1440)
    expect(decodeCacheHintMinutes(observed, entry)).toBe(0)
  })

  test('never returns a negative hint when the hint was capped by maxInterval', () => {
    // refreshDelay huge -> Miniflux caps at maxInterval; the decode understates
    // the true hint but must never go negative (it is applied as a floor).
    const observed = minifluxWrites(397, 100000)
    expect(observed).toBe(1440)
    const entry = entryFrequencyIntervalMinutes(397, 1, 5, 1440)
    expect(decodeCacheHintMinutes(observed, entry)).toBeGreaterThan(0)
    expect(decodeCacheHintMinutes(observed, entry)).toBeLessThanOrEqual(1440 - entry)
  })
})
