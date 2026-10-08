import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

import { loadConfig } from './config'

/**
 * Cookie name. The `__Host-` prefix is a browser-ENFORCED contract, not a
 * convention: the browser refuses to send the cookie unless it is `Secure`,
 * `Path=/` and has no `Domain`. That makes cookie injection from a sibling
 * subdomain impossible. It is used whenever the session is signed, because the
 * prefix mandates `Secure` and unsigned mode is local-HTTP development only.
 */
const SIGNED_COOKIE_NAME = '__Host-mf_session'
const UNSIGNED_COOKIE_NAME = 'mf_session'

/**
 * Sliding inactivity window. The cookie is re-issued on every authenticated
 * request, so this is time-since-last-use, not time-since-login.
 *
 * NOTE: because sessions are stateless (HMAC, no server-side store), re-issuing
 * the cookie does NOT invalidate older ones — any previously signed cookie
 * stays valid until its own expiry. Rotation would need session state.
 */
const SESSION_MAX_AGE = 14 * 24 * 60 * 60

export interface Session {
  /** Miniflux API key minted for this session (valid until logout). */
  token: string
  /** ID of the Miniflux API key (to DELETE on logout). */
  keyId: number
  /** Username the session belongs to (informational). */
  username: string
  /** Miniflux user id — keys the per-account preference store. */
  userId?: number
  /**
   * Absolute expiry, epoch milliseconds. SIGNED, so unlike the cookie's own
   * `maxAge` a holder cannot rewrite it — the cookie's maxAge is advisory and
   * client-controlled, this is authoritative. Sessions minted before this field
   * existed carry no `exp` and are rejected outright.
   */
  exp: number
}

/** Signed sessions get the `__Host-` name; unsigned dev gets the plain one. */
function cookieName(): string {
  return loadConfig().sessionSecret == null ? UNSIGNED_COOKIE_NAME : SIGNED_COOKIE_NAME
}

/**
 * HMAC-sign a session payload into a cookie token.
 * Format: base64(payload).hex(signature). The hex signature is over that exact
 * payload string, so any tamper makes it mismatch.
 *
 * With no configured secret the token is the payload UNSIGNED. That is dev
 * only and exists so `bun dev` needs no secrets; see `loadConfig`, which
 * refuses to boot that way outside development.
 */
function sign(payload: string): string {
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  const secret = loadConfig().sessionSecret
  if (secret == null) return b64
  return `${b64}.${createHmac('sha256', secret).update(payload).digest('hex')}`
}

/** Verify + decode a cookie token; null when absent/malformed/tampered. */
function unsign(raw: string | undefined): Session | null {
  if (!raw) return null
  const secret = loadConfig().sessionSecret
  const dot = raw.lastIndexOf('.')

  let payload: string
  if (secret == null) {
    // Unsigned mode. A signed-looking token here means the modes disagree
    // (e.g. a cookie minted by a production build) — refuse it rather than
    // silently ignore the signature.
    if (dot >= 0) return null
    payload = Buffer.from(raw, 'base64url').toString('utf8')
  } else {
    // Signed mode: an unsigned token is exactly what an attacker would forge,
    // so the absence of a signature is a hard reject, not a fallback.
    if (dot < 0) return null
    payload = Buffer.from(raw.slice(0, dot), 'base64url').toString('utf8')
    const expected = createHmac('sha256', secret).update(payload).digest('hex')
    const a = Buffer.from(raw.slice(dot + 1))
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  }

  try {
    const parsed = JSON.parse(payload) as Session
    if (typeof parsed.token !== 'string' || typeof parsed.keyId !== 'number') return null
    // Expiry is part of the signed material, so it is authoritative. A cookie
    // without it predates this field and must be re-issued by a fresh login.
    if (typeof parsed.exp !== 'number' || !Number.isFinite(parsed.exp)) return null
    if (parsed.exp <= Date.now()) return null
    return parsed
  } catch {
    return null
  }
}

/** Read the session from a request's cookies (no side effects). */
export function readSession(ctx: Context): Session | null {
  return unsign(getCookie(ctx, cookieName()))
}

/** Set the session cookie on a response. Called on every authenticated request
 *  so both the cookie's maxAge and the signed `exp` slide forward with use.
 *
 *  `SameSite=Lax` rather than Strict: Strict is withheld on any cross-site
 *  navigation, so arriving via a bookmark/shortcut/referrer after a browser
 *  restart sends no cookie and the app renders "logged out". Lax still blocks
 *  cross-site non-GET, which is what protects the mutating routes.
 *  Both `maxAge` and `expires` are emitted so the cookie is unambiguously
 *  persistent rather than a browser-session cookie. */
export function writeSession(ctx: Context, session: Omit<Session, 'exp'>): void {
  const expires = Date.now() + SESSION_MAX_AGE * 1000
  setCookie(ctx, cookieName(), sign(JSON.stringify({ ...session, exp: expires })), {
    httpOnly: true,
    sameSite: 'Lax',
    secure: loadConfig().sessionSecret != null,
    path: '/',
    maxAge: SESSION_MAX_AGE,
    expires: new Date(expires),
  })
}

/** Clear the session cookie (logout). */
export function clearSession(ctx: Context): void {
  setCookie(ctx, cookieName(), '', {
    httpOnly: true,
    sameSite: 'Lax',
    secure: loadConfig().sessionSecret != null,
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  })
}
