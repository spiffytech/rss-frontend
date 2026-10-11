/**
 * Sets a user's password (argon2id). The password is read from STDIN — never
 * argv (argv leaks to process listings and shell history).
 *
 *   echo -n 'correct horse' | bun run scripts/set-password.ts spiffy
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { eq } from 'drizzle-orm'

import { openDatabase } from '../src/server/db'
import { users } from '../src/server/db/schema'

// Paths resolve against the repo root (app/scripts/.. /..), not the CWD.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const username = process.argv[2]
if (!username) {
  console.error('usage: set-password.ts <username>   (password on stdin)')
  process.exit(2)
}
if (process.stdin.isTTY) console.error('reading password from stdin (Ctrl-D to finish)…')

const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '')
if (password.length < 8) {
  console.error('refusing: password must be at least 8 characters')
  process.exit(1)
}

const passwordHash = await Bun.password.hash(password, { algorithm: 'argon2id' })
const handle = openDatabase(process.env.READER_DB_PATH ?? join(repoRoot, 'data', 'reader.sqlite'))
try {
  const result = handle.db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.username, username.toLowerCase()))
    .run()
  if (result.changes === 0) {
    console.error(`no user '${username}' — run the import first`)
    process.exit(1)
  }
  console.log(`password set for ${username}`)
} finally {
  handle.sqlite.close()
}
