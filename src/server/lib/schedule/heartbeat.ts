/**
 * Tick-freshness state for the scheduler loop and the /health route.
 *
 * A tick only counts as *completed* when it succeeded — a failed tick records
 * the error but does not refresh `lastTickAt`, so persistent failures age out
 * and /health reports 503 instead of silently pretending all is well.
 */

export interface Heartbeat {
  /** True once startScheduler() has run. */
  enabled: boolean
  /** Last successful (completed) tick. */
  lastTickAt: Date | null
  /** Most recent tick attempt, success or failure. */
  lastAttemptAt: Date | null
  lastTickOk: boolean | null
  lastTickError: string | null
}

const state: Heartbeat = {
  enabled: false,
  lastTickAt: null,
  lastAttemptAt: null,
  lastTickOk: null,
  lastTickError: null,
}

export function markSchedulerStarted(): void {
  state.enabled = true
}

export function markTick(ok: boolean, error?: string): void {
  state.lastAttemptAt = new Date()
  state.lastTickOk = ok
  state.lastTickError = ok ? null : (error ?? 'unknown error')
  if (ok) state.lastTickAt = state.lastAttemptAt
}

export function getHeartbeat(): Heartbeat {
  return { ...state }
}

/** Minutes since the last completed tick; null when none happened. */
export function lastTickAgeMinutes(now: Date = new Date()): number | null {
  if (!state.lastTickAt) return null
  return (now.getTime() - state.lastTickAt.getTime()) / 60_000
}

/** True when the scheduler is enabled and its last completed tick is stale/absent. */
export function isTickStale(maxTickAgeMinutes: number, now: Date = new Date()): boolean {
  if (!state.enabled) return false
  const age = lastTickAgeMinutes(now)
  return age == null || age > maxTickAgeMinutes
}
