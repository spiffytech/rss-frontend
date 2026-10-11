/**
 * Database opener: bun:sqlite + Drizzle (query builder only, sync throughout).
 *
 * Pragmas are ported from the old prefs side-DB (our own code). Migrations run
 * from ./drizzle (drizzle-kit generate).
 *
 * `bun:sqlite` is required lazily (sync, via createRequire) so the module graph
 * loads under any ESM loader — SvelteKit's build-time route analysis imports
 * the server bundle in a worker where `bun:` URLs don't resolve. Only when a
 * handler actually opens the DB does the Bun builtin load (runtime is Bun).
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Database } from 'bun:sqlite'

import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

const nodeRequire = createRequire(import.meta.url)

function openBunDatabase(path: string): Database {
  // `create: true` makes the FILE, not its parent directory (the old prefs
  // side-DB mkdir'd first for exactly this reason).
  mkdirSync(dirname(path), { recursive: true })
  const { Database } = nodeRequire('bun:sqlite') as typeof import('bun:sqlite')
  return new Database(path, { create: true })
}

export function openDatabase(path: string): {
  sqlite: Database
  db: ReturnType<typeof drizzle>
} {
  const sqlite = openBunDatabase(path)
  applyPragmas(sqlite)
  const db = drizzle(sqlite)
  // MIGRATIONS_DIR for the bundled server (import.meta.url lands inside
  // build/ chunks there, so the relative path stops resolving); dev default
  // unchanged.
  migrate(db, {
    migrationsFolder: process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../drizzle/', import.meta.url)),
  })
  return { sqlite, db }
}

export type ReaderHandle = ReturnType<typeof openDatabase>

function applyPragmas(db: Database): void {
  for (const [pragma, value] of [
    ['journal_mode', 'WAL'],
    ['synchronous', 'NORMAL'],
    ['foreign_keys', 'ON'],
    ['temp_store', 'MEMORY'],
    ['cache_size', '-64000'],
    ['mmap_size', '536870912'],
    ['page_size', '32768'],
    ['busy_timeout', '5000'],
    ['wal_autocheckpoint', '10000'],
  ] as const) {
    db.run(`PRAGMA ${pragma} = ${value}`)
  }
}
