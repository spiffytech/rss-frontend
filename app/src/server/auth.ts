/**
 * Session auth: one HMAC-signed cookie, no sessions table (two accounts don't
 * pay for mid-TTL revocation). Passwords verify with argon2id (set via
 * scripts/set-password.ts).
 */
import { timingSafeEqual } from 'node:crypto'

import { eq } from 'drizzle-orm'

import type { UserId } from '../shared/ids'
import type { ReaderHandle } from './db'
import { users } from './db/schema'

export type SessionUser = { id: UserId; username: string }

export const SESSION_COOKIE = 'reader_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

function secret(): string {
  const fromEnv = process.env.SESSION_SECRET
  if (fromEnv) return fromEnv
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production')
  }
  return 'dev-only-secret' // rotating per process in dev is fine
}

function hmac(payload: string): string {
  // Bun's HMAC entry point: CryptoHasher with a secret key.
  return new Bun.CryptoHasher('sha256', secret()).update(payload).digest('base64url')
}

export function signSession(user: SessionUser): string {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, username: user.username, exp: Date.now() + SESSION_TTL_MS }),
  ).toString('base64url')
  return `${payload}.${hmac(payload)}`
}

export function readSession(cookie: string | undefined): SessionUser | null {
  if (!cookie) return null
  const dot = cookie.lastIndexOf('.')
  if (dot < 0) return null
  const payload = cookie.slice(0, dot)
  const signature = cookie.slice(dot + 1)
  const expected = hmac(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string
      username: string
      exp: number
    }
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null
    return { id: data.id as UserId, username: data.username }
  } catch {
    return null
  }
}

export function sessionCookieOptions(): {
  httpOnly: true
  sameSite: 'lax'
  path: '/'
  maxAge: number
  secure: boolean
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
    secure: process.env.NODE_ENV === 'production',
  }
}

/** Verify a login attempt. Returns the user or null (never reveals which). */
export function verifyLogin(
  handle: ReaderHandle,
  username: string,
  password: string,
): SessionUser | null {
  const row = handle.db
    .select({ id: users.id, username: users.username, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.username, username.toLowerCase()))
    .get()
  if (!row || row.passwordHash === '') return null
  const ok = Bun.password.verifySync(password, row.passwordHash)
  return ok ? { id: row.id, username: row.username } : null
}
