import type { RequestHandler } from './$types'

import { getHeartbeat, isTickStale, lastTickAgeMinutes } from '../../server/scheduler/heartbeat'
import { loadSchedulerConfig } from '../../server/scheduler/config'

/** Liveness of the scheduler loop (see docs/feed-scheduler.md): 503 once the
 *  last completed tick ages past SCHEDULER_MAX_TICK_AGE_MINUTES. Reports 200
 *  when the scheduler is disabled — a stopped scheduler is a choice, not a
 *  stale loop. */
export const GET: RequestHandler = async () => {
  let maxTickAgeMinutes = 5
  try {
    maxTickAgeMinutes = loadSchedulerConfig().maxTickAgeMinutes
  } catch {
    // Bad config: the scheduler never started; judge from the heartbeat alone.
  }
  const stale = isTickStale(maxTickAgeMinutes)
  return new Response(
    JSON.stringify({ ok: !stale, scheduler: { ...getHeartbeat(), tickAgeMinutes: lastTickAgeMinutes() } }),
    { status: stale ? 503 : 200, headers: { 'content-type': 'application/json' } },
  )
}
