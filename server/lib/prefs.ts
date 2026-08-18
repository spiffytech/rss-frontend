/**
 * Per-account reader preferences, stored in SQLite.
 *
 * Two scopes:
 *   - `user`     — account-wide: { hideEmptyFeeds, collapsedCats, disabledAutoReadFeeds }
 *   - `feed:<id>` — per-feed view defaults: { viewMode, sort, hideReadItems }
 *
 * The global view/sort/hideReadItems defaults are intentionally hardcoded
 * (expanded / oldest / hide=true) until a global preference UI exists; the
 * `feed:` scope overrides them when present.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'

import { loadConfig } from './config'

export interface UserPrefs {
  hideEmptyFeeds?: boolean
  collapsedCats?: Record<string, boolean>
  disabledAutoReadFeeds?: number[]
}

export interface FeedPrefs {
  viewMode?: 'expanded' | 'list'
  sort?: 'oldest' | 'newest'
  hideReadItems?: boolean
}

let db: Database | null = null

function getDb(): Database {
  if (!db) {
    // Ensure the parent directory exists (e.g. the default `./data/` in local
    // dev); Docker's Dockerfile pre-creates /data, but local runs do not.
    mkdirSync(dirname(loadConfig().prefsDbPath), { recursive: true })
    db = new Database(loadConfig().prefsDbPath, { create: true })
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_prefs (
        user_id INTEGER NOT NULL,
        scope   TEXT    NOT NULL,
        prefs   TEXT    NOT NULL DEFAULT '{}',
        PRIMARY KEY (user_id, scope)
      );
    `)
  }
  return db
}

function readScope(userId: number, scope: string): Record<string, unknown> {
  const row = getDb()
    .query<{ prefs: string }, [number, string]>(
      'SELECT prefs FROM user_prefs WHERE user_id = ? AND scope = ?',
    )
    .get(userId, scope)
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.prefs)
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeScope(userId: number, scope: string, prefs: Record<string, unknown>): void {
  getDb()
    .query('INSERT INTO user_prefs (user_id, scope, prefs) VALUES (?, ?, ?) ON CONFLICT (user_id, scope) DO UPDATE SET prefs = excluded.prefs')
    .run(userId, scope, JSON.stringify(prefs))
}

/** Account-wide preferences (hideEmptyFeeds, collapsedCats, disabledAutoReadFeeds). */
export function getUserPrefs(userId: number): UserPrefs {
  const raw = readScope(userId, 'user')
  return {
    hideEmptyFeeds: typeof raw.hideEmptyFeeds === 'boolean' ? raw.hideEmptyFeeds : undefined,
    collapsedCats:
      typeof raw.collapsedCats === 'object' && raw.collapsedCats !== null
        ? (raw.collapsedCats as Record<string, boolean>)
        : undefined,
    disabledAutoReadFeeds: Array.isArray(raw.disabledAutoReadFeeds)
      ? (raw.disabledAutoReadFeeds as number[])
      : undefined,
  }
}

/** Merge a partial account-wide preference update into the store. */
export function saveUserPrefs(userId: number, patch: UserPrefs): void {
  writeScope(userId, 'user', { ...readScope(userId, 'user'), ...patch })
}

/** Per-feed view defaults, or null when none are stored. */
export function getFeedPrefs(userId: number, feedId: number): FeedPrefs | null {
  const raw = readScope(userId, `feed:${feedId}`)
  const out: FeedPrefs = {}
  if (raw.viewMode === 'expanded' || raw.viewMode === 'list') out.viewMode = raw.viewMode
  if (raw.sort === 'oldest' || raw.sort === 'newest') out.sort = raw.sort
  if (typeof raw.hideReadItems === 'boolean') out.hideReadItems = raw.hideReadItems
  return Object.keys(out).length > 0 ? out : null
}

/** Merge a partial per-feed preference update into the store. */
export function saveFeedPrefs(userId: number, feedId: number, patch: FeedPrefs): void {
  writeScope(userId, `feed:${feedId}`, { ...readScope(userId, `feed:${feedId}`), ...patch })
}
