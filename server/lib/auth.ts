import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

import { loadConfig } from './config'

const COOKIE_NAME = 'mf_session'

export interface Session {
  /** Miniflux API key minted for this session (valid until logout). */
  token: string
  /** ID of the Miniflux API key (to DELETE on logout). */
  keyId: number
  /** Username the session belongs to (informational). */
  username: string
  /** Miniflux user id — keys the per-account preference store. */
  userId?: number
}

/**
 * HMAC-sign a session payload into a single cookie token.
 * Format: base64(payload).hex(signature). `payload` is compact JSON; the hex
 * signature is over that exact string, so any tamper makes the sig mismatch.
 */
function sign(payload: string): string {
  const secret = loadConfig().sessionSecret
  const sig = createHmac('sha256', secret).update(payload).digest('hex')
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sig}`
}

/** Verify + decode a signed cookie token; null when absent/malformed/tampered. */
function unsign(raw: string | undefined): Session | null {
  if (!raw) return null
  const dot = raw.lastIndexOf('.')
  if (dot < 0) return null
  const [b64, sig] = [raw.slice(0, dot), raw.slice(dot + 1)]
  let payload: string
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const secret = loadConfig().sessionSecret
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const parsed = JSON.parse(payload) as Session
    if (typeof parsed.token !== 'string' || typeof parsed.keyId !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** Read the session from a request's cookies (no side effects). */
export function readSession(ctx: Context): Session | null {
  return unsign(getCookie(ctx, COOKIE_NAME))
}

/** Set the session cookie on a response. */
export function writeSession(ctx: Context, session: Session): void {
  setCookie(ctx, COOKIE_NAME, sign(JSON.stringify(session)), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Session cookie by default (no expires) — dies with the browser tab.
  })
}

/** Clear the session cookie (logout). */
export function clearSession(ctx: Context): void {
  setCookie(ctx, COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  })
}

/** Fresh session-id nonce (not strictly needed for HMAC, kept for clarity). */
export function newSessionId(): string {
  return randomUUID()
}
