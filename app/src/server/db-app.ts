/** The app's one DB handle (long-lived process, sync SQLite). */
import { fileURLToPath } from 'node:url'
import { openDatabase, type ReaderHandle } from './db'

let handle: ReaderHandle | null = null

export function appDbPath(): string {
  return process.env.READER_DB_PATH ?? fileURLToPath(new URL('../../../data/reader.sqlite', import.meta.url))
}

export function appDb(): ReaderHandle {
  if (!handle) {
    handle = openDatabase(appDbPath())
  }
  return handle
}
