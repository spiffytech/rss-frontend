import type { RequestHandler } from './$types'
import { eq } from 'drizzle-orm'

import { handle } from '../../../../server/api-helpers'
import { feeds } from '../../../../server/db/schema'
import { fetchAndIngest } from '../../../../server/fetch/fetch-feed'
import { verifySignature } from '../../../../server/websub'

/**
 * WebSub callback. Deliberately UNAUTHENTICATED — hubs POST here as themselves.
 * The per-feed token in the URL is what makes this safe: it is 32 bytes of
 * randomness and is the only way to address a feed, so a stranger cannot aim a
 * notification at one, nor make us fetch anything but a feed's own URL. The same
 * token doubles as the HMAC secret.
 *
 * GET  — hub verification: echo hub.challenge
 * POST — a notification arrived: refetch that feed now
 */

export const GET: RequestHandler = async ({ params, url }) => {
  const mode = url.searchParams.get('hub.mode')
  const challenge = url.searchParams.get('hub.challenge')
  const topic = url.searchParams.get('hub.topic')
  if (mode !== 'subscribe' && mode !== 'unsubscribe') return new Response('bad mode', { status: 400 })
  if (!challenge) return new Response('no challenge', { status: 400 })

  const db = handle()
  const feed = db.db.select().from(feeds).where(eq(feeds.websubToken, params.token as string)).get()
  if (!feed) return new Response('unknown subscription', { status: 404 })
  // The hub tells us which topic it thinks it is verifying. Refuse a mismatch so
  // one feed's token can never be used to verify another's.
  if (topic && topic !== feed.feedUrl) return new Response('topic mismatch', { status: 404 })

  // On unsubscribe the hub is confirming a teardown: drop the lease so the
  // scheduler knows to keep polling rather than wait for a push that is not coming.
  if (mode === 'unsubscribe') {
    db.db.update(feeds).set({ websubLeaseUntil: null }).where(eq(feeds.id, feed.id)).run()
  }
  return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } })
}

export const POST: RequestHandler = async ({ params, request }) => {
  const raw = await request.text()
  const db = handle()
  const feed = db.db.select().from(feeds).where(eq(feeds.websubToken, params.token as string)).get()
  if (!feed) return new Response('unknown subscription', { status: 404 })
  if (!verifySignature(feed.websubToken ?? '', raw, request.headers.get('x-hub-signature'))) {
    return new Response('bad signature', { status: 403 })
  }
  // The payload is ignored on purpose: hubs differ (full document vs bare ping)
  // and the feed is the source of truth anyway. One fetch makes them all alike.
  try {
    await fetchAndIngest({ handle: db, feedId: feed.id })
  } catch {
    // A failed fetch is not the hub's problem. A 2xx keeps the subscription
    // alive and the poller catches whatever we missed.
  }
  return new Response(null, { status: 200 })
}
