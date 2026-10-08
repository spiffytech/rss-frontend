# External feed scheduler

Decides *when* each feed is fetched. Miniflux stays the fetcher, parser and
store; we only write `feeds.next_check_at`. Not intended for upstream.

## The control model

Miniflux is still the scheduler. Its `feedScheduler` ticker calls
`ScheduleNextCheck` after **every** refresh, so it rewrites `next_check_at`
every time. We are not the scheduler — we are a supervisor that reasserts a
value on a loop.

**Hard invariant: loop period < `SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL`.**

We only win a feed when our write lands before its next fetch is due. With a
1-minute loop and Miniflux's 5-minute minimum interval we always land first,
which is the only reason the pathological cases (see below) get fixed at all.
Drop the minimum interval below the loop period and we lose control of exactly
those feeds, silently.

Consequences, accepted:

- Control is advisory and lossy. If our loop stalls longer than Miniflux's
  interval, the instance quietly reverts to `entry_frequency`. That is the
  designed degradation, not a failure mode.
- Miniflux rewrites `next_check_at` between our writes. Read `checked_at` and
  `next_check_at` *before* overwriting so we can decode state (below).

## Budget

```
B_today = clamp( ceil( itemsPerActiveDay × P(active today) × SCHEDULER_BUDGET_FACTOR ),
                 minPollsPerDay, maxPollsPerDay )
```

- `P(active today)` = 1 / 0 when a weekday signal exists, else the observed
  frequency of active days.
- With no day signal the product collapses to `N / learningWindow` — a rate with
  a **fixed** denominator. That is why there is no separate "sparse fallback"
  path; the sparse case is this expression in its low-data limit.

Miniflux's own `weeklyCount` is `ceil(604800 / mean_gap)` where
`mean_gap = (max − min) / (count − 1)`. The denominator is the data's own span,
so clustered entries collapse it and the feed looks infinitely fast. Two
entries five minutes apart are polled 288×/day for a week. We never divide by a
data-derived span, so that failure mode is structurally absent.

## Poll-rate bounds

Read from the **same** env vars Miniflux reads, so the two cannot drift:

| derived | from |
|---|---|
| `maxPollsPerDay` = 1440 / minIntervalMinutes | `SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL` |
| `minPollsPerDay` = 1440 / maxIntervalMinutes | `SCHEDULER_ENTRY_FREQUENCY_MAX_INTERVAL` |

Declared once in `compose.yml` and interpolated into both services. Overridable
via `MINIFLUX_MIN_INTERVAL_MINUTES`, `MINIFLUX_MAX_INTERVAL_MINUTES`,
`MINIFLUX_ENTRY_FREQUENCY_FACTOR`. Miniflux parses these as `minuteType`, so
`"5"` means five minutes. We reject `min > max` the same way
`internal/config/parser.go` does.

## Cache hints

**Miniflux DOES honour cache hints, and it persists them.** (An earlier version
of this document claimed the opposite — it had read only the pre-fetch call at
`handler.go:230` and missed the post-fetch ones.) The sequence is:

- `handler.go:230` — `ScheduleNextCheck(weeklyEntryCount, time.Duration(0))`
  before fetching, which is just the entry-frequency default.
- `handler.go:309-312` — on success, `refreshDelay = max(feedTTL,
  Cache-Control max-age, Expires)` and `ScheduleNextCheck(weeklyEntryCount,
  refreshDelay)`.
- `handler.go:255-256` — when rate-limited (HTTP 429), `retryDelay =
  ParseRetryDelay()` (the `Retry-After` header) and `ScheduleNextCheck(
  weeklyEntryCount, retryDelay)`.
- `model/feed.go` `ScheduleNextCheck` does `interval = max(interval,
  refreshDelay)` then `NextCheckAt = now + interval`, and `UpdateFeed` /
  `UpdateFeedError` persist it.

**Consequence: we must not clobber those values.** Writing our own
`next_check_at` over a `Retry-After` tells a rate-limited server we will not
back off — the opposite of the politeness requirement. The probe-backoff branch
is especially dangerous here, because a 429 increments `parsing_error_count`
via the parse-error path and so *activates* the branch that overwrites it.

We recover the hint by decoding what Miniflux wrote:

```
refreshDelay = max(0, (next_check_at − checked_at) − entryFrequencyInterval)
```

`entryFrequencyInterval` is recomputed from `weeklyCount` as Miniflux would.
Read this **before** overwriting `next_check_at`, then apply
`interval = max(ourInterval, refreshDelay)` to our own target so honoured
hints survive. Decode it **only when `checked_at` advanced**, which proves
Miniflux was the last writer (`UpdateFeed`/`UpdateFeedError` write both
columns together; our writes never touch `checked_at`). Decoding on any other
tick reads our own value as if it were the origin's and compounds it — that
bug pushed a feed 42 hours out before it was caught.

## Errors and backoff

**Miniflux has no backoff for ordinary errors.** `RefreshFeed` calls
`CheckedNow()` and `ScheduleNextCheck(weeklyEntryCount, 0)` *before* fetching;
the failure path (`UpdateFeedError`) then writes that already-computed
`next_check_at`. So a broken feed is retried at exactly its entry-frequency
interval — 5 minutes for anything that merely looks high-volume — until it
trips the error limit. **The one exception is HTTP 429**, where `Retry-After`
is honoured (see Cache hints above).

Two consequences:

- **`POLLING_PARSING_ERROR_LIMIT` is purely an eligibility filter.**
  `storage/batch.go` adds `parsing_error_count < limit` to the job query, so a
  feed at the limit is never polled again and no amount of writing
  `next_check_at` rescues it. Set it to `0` and `WithErrorLimit` adds no clause
  at all — every feed stays eligible forever.
- **We must supply the backoff ourselves.** With the limit at 0 and no Miniflux
  backoff, a failing feed would otherwise be hammered at its entry-frequency
  interval indefinitely.

`parsing_error_count` is already a free streak counter: `model/feed.go`
increments it on every failure and zeroes it on success, and nothing else
mutates it. Use it as the backoff exponent — no extra state:

```
probeInterval = clamp( 1h × 2^(min(parsing_error_count, 8) − 1),
                       SCHEDULER_ENTRY_FREQUENCY_MIN_INTERVAL,
                       SCHEDULER_FAILING_FEED_MAX_INTERVAL )
```

The floor is the *minimum* interval, not the entry-frequency interval: a feed
that merely looks high-volume (see the span bug above) would otherwise be
re-probed every five minutes while broken.

A permanently broken feed settles at one probe per `MAX_INTERVAL` (default 7d)
instead of going dead or being hammered. On success the counter zeroes and the
learned schedule resumes. The only knob is the ceiling.

Cosmetic cost of `=0`: `nav_metadata` hardcodes `count_error_feeds` to 0, so
the sidebar error count reads zero. `CountAllFeedsWithErrors` (the metrics
endpoint) is unaffected — it clamps the limit to 1.

## Writes

Single-statement bulk CAS, one statement per cycle:

```sql
UPDATE feeds SET next_check_at = v.target
FROM (VALUES (id, target, expected_checked_at), ...) v(id, target, expected)
WHERE feeds.id = v.id AND feeds.checked_at = v.expected;
```

Zero rows affected for a feed means Miniflux moved it underneath us — recompute.
Only named columns are written; `ScheduleNextCheck` is never no-op'd (it is the
fallback when we are down).

## Learning

From `published_at` **only**. `created_at` is import-gated — 525/545 rows share
one burst timestamp — and is never read by the scheduling path.

- Sentinel: drop `published_at <= 2000-01-01` (four rows carry `0001-01-01`).
- 48-bin circular density over minute-of-day, smoothed 3×, seam at the quietest
  hour so the wrap point never splits a mode.
- A mode counts only with `>= 3` raw samples in its bin. Counting smoothed peaks
  alone inflates the poll budget on sparse feeds.
- All timestamps handled as UTC. Consistency matters; the weekday gate is
  shifted by one day for feeds publishing after 19:00 US/Eastern, which is
  harmless because it is shifted consistently. DST blurs one bin twice a year.

## Measuring success

`created_at − published_at` on entries **inserted after the deploy timestamp**
is real publish-to-read latency — Miniflux stamps `created_at` at insert time.
Existing rows are import-gated and must be excluded. This is the scoreboard.

## Baseline (before the scheduler, live `entry_frequency`)

Captured 2026-10-04 from `created_at − published_at`, entries created in the
trailing 30 days, excluding `published_at <= 2000-01-01` and clock-skewed rows:

| n | mean | p50 | p90 |
|---|---|---|---|
| 9,856 | 7,872 min | **109 min** | **1,292 min** |

The mean is meaningless — a few backfilled entries drag it to days. **p50 109
min / p90 1,292 min** are the numbers to beat.

Methodological catch: this is measured over feeds that are *currently
producing entries*, which excludes the 73 feeds stuck at the error limit.
Reviving them will pull the numbers up, so compare before/after on a **fixed
feed set**, not on the whole instance.

## Known limitations

- Drifting publication times (~11h mean) — a learned time-of-day cannot track a
  moving one.
- Wide-spread daily feeds (~2.5h) — raise `SCHEDULER_BUDGET_FACTOR` to 2 to
  halve this at ~2× polls.
- Date-only `published_at` (~5h) — no time-of-day signal exists.
- Sparse/unpredictable feeds sit at the 24h floor by design.
