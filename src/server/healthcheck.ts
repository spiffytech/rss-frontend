/**
 * Container healthcheck. Runs as a SEPARATE process from the server, which is
 * the whole point: a stalled or dead scheduler cannot report itself, so the
 * thing being watched must never be the thing doing the watching.
 *
 * Reports unhealthy when GET /health fails -- which already covers a silently
 * stalled scheduler loop, not just an unresponsive HTTP server (see the /health
 * route in app.ts).
 *
 * Debounced: posts to ntfy once per incident rather than once per 30s health
 * tick, using a marker file on the /data volume. Clearing the marker on
 * recovery means the next incident alerts again.
 *
 * Run: bun run src/server/healthcheck.ts   (exit 0 = healthy)
 */
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const port = Number(process.env.PORT) || 3000
const ntfyUrl = process.env.MINIFLUX_SCHEDULER_NTFY_URL || ''
const dataDir = dirname(process.env.prefsDbPath || './data/prefs.sqlite')
const marker = join(dataDir, '.health-unhealthy')

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(4000),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Post the alert. Returns true only when it actually landed. */
async function alert(reason: string): Promise<boolean> {
  if (!ntfyUrl) return true // alerts disabled = nothing to confirm
  try {
    await fetch(ntfyUrl, {
      method: 'POST',
      headers: { Title: 'miniflux scheduler unhealthy' },
      body: `${process.env.HOSTNAME ?? 'unknown host'}: ${reason}`,
      signal: AbortSignal.timeout(5000),
    })
    return true
  } catch {
    // Never let alerting break the healthcheck — but do report the miss so the
    // caller can retry rather than assume the incident was announced.
    return false
  }
}

const ok = await healthy()
if (ok) {
  if (existsSync(marker)) {
    try {
      unlinkSync(marker)
    } catch (e) {
      // A marker we cannot clear silences every FUTURE incident, because the
      // debounce short-circuits on it. Say so rather than pretending we
      // recovered cleanly.
      await alert(`recovered, but could not clear the debounce marker: ${String(e)}`)
    }
  }
  process.exit(0)
}

// Debounce: skip the alert once this incident has been announced. The marker is
// written only AFTER a successful alert, so a failed POST is retried on the
// next run instead of silencing the whole outage. Writing it first made the
// comment "already alerted for this incident" an unverifiable assumption — the
// marker meant *attempted*, not *delivered*.
if (existsSync(marker)) process.exit(1)

if (await alert('/health is failing')) {
  try {
    writeFileSync(marker, new Date().toISOString())
  } catch {
    // Read-only volume: no debounce available, so we alert on every run.
  }
}
process.exit(1)
