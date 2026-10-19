// Scratch simulator for the external histogram scheduler.
// Run: bun run playground/scripts/poll-sim.ts
//
// Each event has a `stamp` (what published_at tells us) and a `true` arrival time
// (what we measure latency against). For date-only feeds these differ on purpose.
// The learner only ever sees stamps.

import { readFileSync } from "fs";

const M = 1440;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const TRAIN = 90, TEST = 90;

type Ev = { s: number; t: number }; // stamp, true arrival (absolute minutes)
type Knobs = { budgetMult: number; retryDiv: number; giveUp: number; minRetry: number; maxRetry: number; rateGateH: number; graceCapH: number };
type Metrics = { B: number; R: number; pollsPerDay: number; wastePerDay: number; mean: number; p50: number; p90: number; p99: number; missRate: number; nItems: number; suppressed: number; caught: number };
type Force = { numModes?: number; boundRetry?: boolean; oldGate?: boolean; rawModes?: boolean };

// ---------- circular empirical quantiles, seam at the quietest hour ----------
function rotate(stamps: number[], bins = 24): { rot: number[]; seamBin: number } {
  const h = new Array(bins).fill(0);
  for (const s of stamps) h[Math.floor((((s % M) + M) % M) / (M / bins))]++;
  const sm = h.map((_, i) => 0.25 * h[(i - 1 + bins) % bins] + 0.5 * h[i] + 0.25 * h[(i + 1) % bins]);
  let seam = 0;
  for (let i = 1; i < bins; i++) if (sm[i] < sm[seam]) seam = i;
  const rot = stamps.map((s) => (((s - seam * (M / bins)) % M) + M) % M).sort((a, b) => a - b);
  return { rot, seamBin: seam };
}
function quantile(sorted: number[], t: number): number {
  if (sorted.length === 0) return 0;
  const idx = clamp(t * (sorted.length - 1), 0, sorted.length - 1);
  const lo = Math.floor(idx), hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (idx - lo) * (sorted[hi] - sorted[lo]);
}

function simulate(events: Ev[], learn: Ev[], k: Knobs, testDays: number, force?: Force): Metrics {
  const stamps = learn.map((e) => e.s % M);
  const { rot, seamBin } = rotate(stamps);
  const binMin = M / 24;
  const toOrig = (r: number) => (r + seamBin * binMin) % M;

  // low-precision stamps (all clustered at/near midnight in real local time) -> spread instead of cluster
  const raw = stamps.slice().sort((a, b) => a - b);
  const q05 = quantile(rot, 0.05), q50 = quantile(rot, 0.5), q95 = quantile(rot, 0.95);
  const spread = q95 - q05;
  const rawSpan = raw.length ? raw[raw.length - 1] - raw[0] : 0;
  const rawMid = raw.length ? raw[Math.floor(raw.length / 2)] : 720;
  const dateOnly = rawSpan < 30 && (rawMid < 15 || rawMid > M - 15);

  // density on a finer grid, for mode counting and the retry give-up rule
  const NB = 48, bw = M / NB;
  const dh = new Array(NB).fill(0);
  for (const s of stamps) dh[Math.floor((((s % M) + M) % M) / bw)]++;
  const smth = (a: number[]) => a.map((_, i) => 0.25 * a[(i - 1 + NB) % NB] + 0.5 * a[i] + 0.25 * a[(i + 1) % NB]);
  const dens = smth(smth(smth(dh)));
  const peak = Math.max(...dens);
  const densAt = (minute: number) => dens[Math.floor((((minute % M) + M) % M) / bw)];

  const ratePerDay = learn.length / 90;
  const activeDays = new Set(learn.map((e) => Math.floor(e.t / M))).size || 1;
  const perActiveDay = learn.length / activeDays;

  // count significant modes so a bimodal feed cannot starve its minority mode
  const meanDens = dens.reduce((a, b) => a + b, 0) / NB;
  const concentrated = peak > 3 * meanDens;
  let numModes = 1;
  if (force?.numModes !== undefined) numModes = force.numModes;
  else if (concentrated) {
    numModes = 0;
    for (let i = 0; i < NB; i++) {
      const prev = dens[(i - 1 + NB) % NB], next = dens[(i + 1) % NB];
      const hit = dens[i] >= 0.2 * peak && dens[i] >= prev && dens[i] > next && (force?.rawModes || dh[i] >= 3);
      if (hit) numModes++;
    }
    numModes = Math.max(1, numModes);
  }

  // weekday gate: only trust the day-of-week pattern with enough samples to mean anything
  const dowCount = new Array(7).fill(0);
  for (const e of learn) dowCount[Math.floor(e.s / M) % 7]++;
  const total = learn.length || 1;
  const publishDays = new Set<number>();
  for (let i = 0; i < 7; i++) if (dowCount[i] / total >= 0.12) publishDays.add(i);
  const dowSignal = total >= 12 && publishDays.size > 0 && publishDays.size < 7;

  // budget = items expected TODAY: perActiveDay x P(active today).
  // With no day signal P falls back to the observed frequency of active days, which
  // collapses the product to N/window -- the robust rate. So there is no separate
  // "sparse fallback" path; it is this expression in its low-data limit.
  const learnDays = new Set(learn.map((e) => Math.floor(e.t / M))).size || 1;
  const pActive = (dow: number) => (dowSignal ? (publishDays.has(dow) ? 1 : 0) : activeDays / learnDays);
  const Bfor: number[] = [];
  for (let d = 0; d < 7; d++) {
    const p = pActive(d);
    Bfor[d] = clamp(Math.max(Math.ceil(perActiveDay * p * k.budgetMult), p >= 1 ? numModes : 1), dateOnly ? 3 : 1, 288);
  }
  const B = Math.max(...Bfor);

  // placement depends only on B, so cache one schedule per distinct B
  const ptCache = new Map<number, number[]>();
  const place = (b: number): number[] => {
    const hit = ptCache.get(b);
    if (hit) return hit;
    const pts: number[] = [];
    if (dateOnly) {
      for (let kk = 1; kk <= b; kk++) pts.push((kk - 0.5) * (M / b));
    } else if (b === 1) {
      // one poll: put it past the bulk of the mode so little arrives after it
      pts.push(toOrig(quantile(rot, 0.85)));
    } else {
      // median of each equal-mass slice: sits inside the bell, so multimodal is respected
      for (let kk = 1; kk <= b; kk++) pts.push(toOrig(quantile(rot, (kk - 0.5) / b)));
    }
    pts.sort((x, y) => x - y);
    const uniq: number[] = [];
    for (const t of pts) if (!uniq.length || t - uniq[uniq.length - 1] > 1) uniq.push(t);
    ptCache.set(b, uniq);
    return uniq;
  };

  const R = clamp(spread / k.retryDiv, k.minRetry, k.maxRetry);
  const graceCap = clamp(spread * 2, 30, k.graceCapH * 60);

  // rate gate: fast feeds are covered by interval alone
  const abs = learn.map((e) => e.t).sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < abs.length; i++) gaps.push(abs[i] - abs[i - 1]);
  const medGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : Infinity;
  // retries are worth it only when an item could plausibly land soon after a poll
  const baseRetry = concentrated && medGap >= k.rateGateH * 60;

  const ev = events.slice().sort((a, b) => a.t - b.t);
  let ptr = 0, lastPoll = -Infinity;
  let caught = 0, latSum = 0, pollCount = 0, wasteCount = 0, suppressed = 0;
  const lats: number[] = [];

  // a poll catches EVERY item since the last poll
  const doPoll = (t: number): boolean => {
    pollCount++;
    let got = 0;
    while (ptr < ev.length && ev[ptr].t <= t) {
      if (ev[ptr].t > lastPoll) {
        caught++; got++;
        lats.push(t - ev[ptr].t); latSum += t - ev[ptr].t;
      }
      ptr++;
    }
    lastPoll = t;
    if (got === 0) wasteCount++;
    return got > 0;
  };

  for (let day = 0; day < testDays; day++) {
    const dayStart = (TRAIN + day) * M;
    const dow = Math.floor(dayStart / M) % 7;
    const allowRetry = force?.oldGate
      ? !(medGap < k.rateGateH * 60 || medGap > 30 * 60 || !concentrated) && (total < 12 || publishDays.size === 0 || publishDays.has(dow))
      : baseRetry && (medGap <= 30 * 60 || (dowSignal && publishDays.has(dow)));
    const pts = place(Bfor[dow]);
    for (const p of pts) {
      const at = dayStart + p;
      if (at <= lastPoll) { suppressed++; continue; }
      if (doPoll(at)) continue;
      if (!allowRetry) continue;

      // keep retrying while we are still inside a bell; stop in the gaps
      const idx = pts.indexOf(p);
      // boundary to the NEXT scheduled poll, wrapping around to tomorrow's first
      const toNext = idx + 1 < pts.length ? pts[idx + 1] - p : (pts[0] + M) - p;
      const bound = force?.boundRetry ? toNext - 0.5 : (idx + 1 < pts.length ? toNext : Infinity);
      const maxElapsed = Math.min(bound, graceCap);
      const floorDens = k.giveUp * peak;
      let next = at + R, guard = 0;
      while (guard++ < 8 && next - at <= maxElapsed && densAt(next % M) >= floorDens) {
        if (doPoll(next)) break;
        next += R;
      }
    }
  }

  lats.sort((x, y) => x - y);
  const pct = (q: number) => lats[Math.min(lats.length - 1, Math.floor(lats.length * q))] ?? 0;
  return {
    B, R: Math.round(R), caught,
    pollsPerDay: pollCount / testDays, wastePerDay: wasteCount / testDays,
    mean: latSum / Math.max(1, caught), p50: pct(0.5), p90: pct(0.9), p99: pct(0.99),
    missRate: 1 - caught / Math.max(1, ev.length), nItems: ev.length, suppressed,
  };
}

// ---------- synthetic distributions ----------
function gen(fn: (d: number, r: () => number) => number[], days: number, seed = 1, dateOnly = false): Ev[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out: Ev[] = [];
  for (let d = 0; d < days; d++) {
    for (const m of fn(d, rnd)) {
      const t = d * M + (((m % M) + M) % M);
      out.push({ s: dateOnly ? d * M : t, t }); // date-only feeds stamp midnight
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
const gauss = (r: () => number) => {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const at = (h: number, mi = 0) => h * 60 + mi;

const synthetics: Record<string, (d: number, r: () => number) => number[]> = {
  daily_punctual: (d, r) => [at(21) + gauss(r) * 5],
  daily_jitter: (d, r) => [at(21) + gauss(r) * 30],
  daily_wide: (d, r) => [at(21) + gauss(r) * 120],
  daily_skewed: (d, r) => [at(20) + Math.abs(gauss(r)) * 90],
  twice_equal: (d, r) => [at(9) + gauss(r) * 10, at(21) + gauss(r) * 10],
  twice_skewed: (d, r) => (r() < 0.7 ? [at(9) + gauss(r) * 10] : [at(21) + gauss(r) * 10]),
  thrice: (d, r) => [at(8) + gauss(r) * 8, at(13) + gauss(r) * 8, at(18) + gauss(r) * 8],
  hourly_uniform: (d, r) => Array.from({ length: 24 }, () => r() * M),
  high_volume: (d, r) => Array.from({ length: 200 }, () => r() * M),
  weekday_punctual: (d, r) => (d % 7 < 5 ? [at(21) + gauss(r) * 5] : []),
  weekday_jitter: (d, r) => (d % 7 < 5 ? [at(21) + gauss(r) * 60] : []),
  weekly_wed: (d, r) => (d % 7 === 3 ? [at(10) + gauss(r) * 15] : []),
  weekly_rand_day: (d, r) => (d % 7 === Math.floor(r() * 7) ? [at(10) + gauss(r) * 15] : []),
  monthly_1st: (d, r) => (d % 30 === 0 ? [at(9) + gauss(r) * 10] : []),
  monthly_rand: (d, r) => (r() < 1 / 30 ? [at(9) + gauss(r) * 10] : []),
  every3_punctual: (d, r) => (d % 3 === 0 ? [at(21) + gauss(r) * 8] : []),
  quad_modes: (d, r) => (d % 7 === 0 || d % 7 === 3 ? [at(8) + gauss(r) * 10, at(18) + gauss(r) * 10] : []),
  uniform_daily: (d, r) => [r() * M],
  uniform_weekly: (d, r) => (d % 7 === 2 ? [r() * M] : []),
  dateonly_daily: (d, r) => [at(14) + gauss(r) * 120], // real 14:00±2h, stamped midnight
  dateonly_weekly: (d, r) => (d % 7 === 3 ? [at(14) + gauss(r) * 120] : []),
  bursty: (d) => (d % 2 === 0 ? [at(14), at(14) + 3, at(14) + 6, at(14) + 8, at(14) + 10] : []),
  // the draft-dumping blogger: 2 items 5 min apart, 3 days a week
  dump_timed: (d) => (d % 7 === 1 || d % 7 === 3 || d % 7 === 5 ? [at(21), at(21) + 5] : []),
  dump_random: (d, r) => {
    if (d % 7 !== 1 && d % 7 !== 3 && d % 7 !== 5) return [];
    const t = r() * M;
    return [t, t + 5];
  },
  // same, but 10 drafts at once -- does the budget over-count burst items?
  dump_ten: (d, r) => {
    if (d % 7 !== 1 && d % 7 !== 3 && d % 7 !== 5) return [];
    const t = r() * M;
    return Array.from({ length: 10 }, (_, i) => t + i * 0.5);
  },
  drifting: (d, r) => [at(21) + d * 15 + gauss(r) * 5],
  rare_yearly: (d, r) => (d % 120 === 40 ? [at(15) + gauss(r) * 20] : []),
  seasonal_gap: (d, r) => ((d % 35) < 21 ? [at(21) + gauss(r) * 20] : []),
  backdated: (d, r) => (d % 2 === 0 ? [at(21) + gauss(r) * 30] : []),
};

// ---------- real feeds ----------
function realFeeds() {
  const samples = new Map<string, { dow: number; min: number }[]>();
  for (const l of readFileSync("/tmp/real_dists.tsv", "utf8").trim().split("\n")) {
    const [u, f, dow, min] = l.split("|");
    const key = u + ":" + f;
    if (!samples.has(key)) samples.set(key, []);
    samples.get(key)!.push({ dow: +dow, min: +min });
  }
  const rates = new Map<string, number>();
  for (const l of readFileSync("/tmp/real_rates.tsv", "utf8").trim().split("\n")) {
    const [u, f, rate] = l.split("|");
    rates.set(u + ":" + f, +rate);
  }
  return [...samples.entries()].map(([key, s]) => ({ key, samples: s, rate: rates.get(key) ?? 1 }));
}

const dowAbs = (abs: number) => Math.floor(abs / M) % 7;
type Feed = { key: string; events: Ev[]; learn: Ev[] };

function buildFeeds(): Feed[] {
  const feeds: Feed[] = [];
  for (const [key, fn] of Object.entries(synthetics)) {
    const ev = gen(fn, TRAIN + TEST, 7, key.startsWith("dateonly"));
    feeds.push({ key, events: ev.filter((e) => e.t >= TRAIN * M), learn: ev.filter((e) => e.t < TRAIN * M) });
  }
  for (const rf of realFeeds()) {
    const byDow: number[][] = Array.from({ length: 7 }, () => []);
    for (const s of rf.samples) byDow[s.dow].push(s.min);
    const all = rf.samples.map((s) => s.min);
    let seed = 991;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const ev: Ev[] = [];
    for (let d = 0; d < TRAIN + TEST; d++) {
      const n = Math.floor(rf.rate) + (rnd() < rf.rate % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const pool = byDow[d % 7].length ? byDow[d % 7] : all;
        const t = d * M + pool[Math.floor(rnd() * pool.length)];
        ev.push({ s: t, t });
      }
    }
    ev.sort((a, b) => a.t - b.t);
    feeds.push({ key: "real:" + rf.key, events: ev.filter((e) => e.t >= TRAIN * M), learn: ev.filter((e) => e.t < TRAIN * M) });
  }
  return feeds;
}

function agg(feeds: Feed[], k: Knobs) {
  let mean = 0, p50 = 0, p90 = 0, p99 = 0, polls = 0, waste = 0, miss = 0, n = 0, pooled = 0, caught = 0;
  for (const f of feeds) {
    const m = simulate(f.events, f.learn, k, TEST);
    if (m.nItems === 0) continue;
    mean += m.mean; p50 += m.p50; p90 += m.p90; p99 += m.p99;
    polls += m.pollsPerDay; waste += m.wastePerDay; miss += m.missRate; n++;
    pooled += m.mean * m.caught; caught += m.caught;
  }
  n = n || 1;
  return { mean: mean / n, p50: p50 / n, p90: p90 / n, p99: p99 / n, polls: polls / n, waste: waste / n, miss: miss / n, pooled: pooled / Math.max(1, caught) };
}

const base: Knobs = { budgetMult: 1, retryDiv: 8, giveUp: 0.15, minRetry: 5, maxRetry: 30, rateGateH: 6, graceCapH: 4 };
const feeds = buildFeeds();
const synth = feeds.filter((f) => !f.key.startsWith("real:"));
const real = feeds.filter((f) => f.key.startsWith("real:"));
console.log(`corpus: ${feeds.length} feeds (${synth.length} synthetic, ${real.length} real replay)\n`);

console.log(`=== sweep (aggregate over ${feeds.length} feeds) ===`);
console.log(`m  q    k  | mean  p50   p90   p99  | polls/d  waste/d  miss%`);
console.log("(q = retry give-up as a fraction of peak density)");
for (const m of [1, 2, 3]) {
  for (const q of [0.05, 0.15, 0.3, 0.5]) {
    for (const div of [4, 8, 12]) {
      const r = agg(feeds, { ...base, budgetMult: m, giveUp: q, retryDiv: div });
      console.log(`${m}  ${q.toFixed(2)}  ${String(div).padStart(2)} | ${r.mean.toFixed(0).padStart(4)}  ${r.p50.toFixed(0).padStart(4)}  ${r.p90.toFixed(0).padStart(4)}  ${r.p99.toFixed(0).padStart(4)}  | ${r.polls.toFixed(2).padStart(7)}  ${r.waste.toFixed(2).padStart(7)}  ${(r.miss * 100).toFixed(1).padStart(5)}`);
    }
  }
}

console.log("\n=== per-distribution, reference config (m=1 q=0.15 k=8) ===");
console.log("distribution            | mean  p50   p90   p99  | polls/d waste/d miss%");
for (const f of synth) {
  const m = simulate(f.events, f.learn, base, TEST);
  console.log(`${f.key.padEnd(23)} | ${m.mean.toFixed(0).padStart(4)}  ${m.p50.toFixed(0).padStart(4)}  ${m.p90.toFixed(0).padStart(4)}  ${m.p99.toFixed(0).padStart(4)}  | ${m.pollsPerDay.toFixed(2).padStart(7)} ${m.wastePerDay.toFixed(2).padStart(7)} ${(m.missRate * 100).toFixed(1).padStart(5)}`);
}

const rr = agg(real, base);
console.log(`\n=== real feeds (${real.length} replayed), reference config ===`);
console.log(`mean=${rr.mean.toFixed(0)}m p50=${rr.p50.toFixed(0)} p90=${rr.p90.toFixed(0)} p99=${rr.p99.toFixed(0)} | polls/d=${rr.polls.toFixed(2)} waste=${rr.waste.toFixed(2)} miss=${(rr.miss * 100).toFixed(1)}%`);

// ---------- baseline: entry_frequency (evenly spaced polls, arbitrary phase, no retries) ----------
function baseline(events: Ev[], learn: Ev[], testDays: number, phase: number) {
  const activeDays = new Set(learn.map((e) => Math.floor(e.t / M))).size || 1;
  const B = clamp(Math.round(learn.length / activeDays), 1, 8);
  const ev = events.slice().sort((a, b) => a.t - b.t);
  let ptr = 0, lastPoll = -Infinity, caught = 0, latSum = 0, pollCount = 0;
  const lats: number[] = [];
  for (let day = 0; day < testDays; day++) {
    for (let k = 0; k < B; k++) {
      const at = (TRAIN + day) * M + phase + k * (M / B);
      pollCount++;
      while (ptr < ev.length && ev[ptr].t <= at) {
        if (ev[ptr].t > lastPoll) { caught++; lats.push(at - ev[ptr].t); latSum += at - ev[ptr].t; }
        ptr++;
      }
      lastPoll = at;
    }
  }
  lats.sort((a, b) => a - b);
  const pct = (q: number) => lats[Math.min(lats.length - 1, Math.floor(lats.length * q))] ?? 0;
  return { mean: latSum / Math.max(1, caught), p50: pct(0.5), p90: pct(0.9), pollsPerDay: pollCount / testDays, caught, latSum };
}

function baselineAgg(fs: Feed[]) {
  let mean = 0, p50 = 0, p90 = 0, polls = 0, n = 0, pooled = 0, caught = 0;
  for (const f of fs) {
    for (let ph = 0; ph < 6; ph++) {
      const r = baseline(f.events, f.learn, TEST, (ph * 241) % 240);
      mean += r.mean; p50 += r.p50; p90 += r.p90; polls += r.pollsPerDay; n++;
      pooled += r.latSum; caught += r.caught;
    }
  }
  n = n || 1;
  return { mean: mean / n, p50: p50 / n, p90: p90 / n, polls: polls / n, pooled: pooled / Math.max(1, caught) };
}

const bAll = baselineAgg(feeds), bReal = baselineAgg(real), bSynth = baselineAgg(synth);
const aAll = agg(feeds, base), aReal = agg(real, base), aSynth = agg(synth, base);
console.log("\n=== entry_frequency baseline vs. this scheduler (m=1 q=0.15 k=8) ===");
console.log("corpus          |        entry_frequency        |        this scheduler");
console.log("                | mean  p50   p90   polls/d     | mean  p50   p90   polls/d");
const row = (n: string, b: any, a: any) =>
  console.log(`${n.padEnd(15)} | ${b.mean.toFixed(0).padStart(4)}  ${b.p50.toFixed(0).padStart(4)}  ${b.p90.toFixed(0).padStart(4)}  ${b.polls.toFixed(2).padStart(7)}     | ${a.mean.toFixed(0).padStart(4)}  ${a.p50.toFixed(0).padStart(4)}  ${a.p90.toFixed(0).padStart(4)}  ${a.polls.toFixed(2).padStart(7)}`);
row("all", bAll, aAll);
row("synthetic", bSynth, aSynth);
row("real (256)", bReal, aReal);
console.log("\npooled (item-weighted) latency, minutes — what a reader actually waits:");
for (const [n2, b, a] of [["all", bAll, aAll], ["synthetic", bSynth, aSynth], ["real (256)", bReal, aReal]] as [string, any, any][]) {
  console.log(`${n2.padEnd(15)} | entry_frequency ${b.pooled.toFixed(0).padStart(4)}   ->   this scheduler ${a.pooled.toFixed(0).padStart(4)}   (${(100 * (a.pooled - b.pooled) / b.pooled).toFixed(0)}%)`);
}

console.log("\n=== creep isolation: real corpus under variants ===");
for (const [name, f] of [["current (C/D)", undefined], ["gate=old only", { oldGate: true }], ["modes=old only", { rawModes: true }], ["both old (=Run B)", { oldGate: true, rawModes: true }], ["numModes=1", { numModes: 1 }]] as [string, Force | undefined][]) {
  let mean = 0, sup = 0, polls = 0, n = 0, pooled = 0, caught = 0;
  for (const fd of real) {
    const m = simulate(fd.events, fd.learn, base, TEST, f);
    if (m.nItems === 0) continue;
    mean += m.mean; sup += m.suppressed / TEST; polls += m.pollsPerDay; n++;
    pooled += m.mean * m.caught; caught += m.caught;
  }
  n = n || 1;
  console.log(`${name.padEnd(16)} | mean ${(mean / n).toFixed(0).padStart(4)}  pooled ${(pooled / Math.max(1, caught)).toFixed(0).padStart(4)}  polls/d ${(polls / n).toFixed(2)}  TOTAL ${polls.toFixed(0).padStart(5)}  sup/d ${(sup / n).toFixed(2)}`);
}

console.log("\n=== worst real feeds (current | boundRetry+numModes=1) ===");
for (const d of real
  .map((fd) => {
    const a = simulate(fd.events, fd.learn, base, TEST);
    const b = simulate(fd.events, fd.learn, base, TEST, { boundRetry: true, numModes: 1 });
    return { key: fd.key, B: a.B, n: a.nItems, cur: a.mean, alt: b.mean, sup: a.suppressed / TEST };
  })
  .sort((x, y) => y.cur - x.cur).slice(0, 12)) {
  console.log(`${d.key.replace("real:", "").slice(0, 26).padEnd(26)} B=${d.B} n=${String(d.n).padStart(5)} cur=${d.cur.toFixed(0).padStart(5)} alt=${d.alt.toFixed(0).padStart(5)} sup/d=${d.sup.toFixed(2)}`);
}
