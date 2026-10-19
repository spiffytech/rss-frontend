import { Database } from 'bun:sqlite'

/** Dump real publish traces for the latency spike. Runs inside the container
 *  against reader.sqlite; prints JSON on stdout. */
const db = new Database('/data/reader.sqlite', { readonly: true })
const host = (u) => { try { return new URL(u).hostname } catch { return '' } }

// 2000-01-01 sentinel: drops the import's date-only/0001 rows.
const SENTINEL = 946684800000
const CUTOFF = Date.now() - 120 * 864e5

const feeds = db.query(`SELECT id, title, feed_url FROM feeds WHERE NOT disabled`).all()
const out = []
for (const f of feeds) {
  const ps = db
    .query(`SELECT published_at FROM entries WHERE feed_id = ? AND published_at > ? AND published_at < ? ORDER BY published_at`)
    .all(f.id, SENTINEL, Date.now())
    .map((r) => r.published_at)
  if (ps.length >= 5) out.push({ id: f.id, title: f.title, host: host(f.feed_url), publishedAt: ps })
}

const total = out.reduce((n, f) => n + f.publishedAt.length, 0)
process.stderr.write(`feeds=${out.length} publishes=${total}\n`)
process.stdout.write(JSON.stringify(out))
