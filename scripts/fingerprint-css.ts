/**
 * Content-fingerprint the compiled Tailwind CSS for cache-busting.
 *
 * Runs the Tailwind CLI (same flags as `build:css`) to compile `main.css`,
 * then copies the compiled bytes to `public/style-<sha256-16>.css` and writes
 * `public/.asset-manifest.json` mapping `/style.css` → the hashed URL:
 *
 *   { "/style.css": "/style-a1b2c3d4e5f60718.css" }
 *
 * The server reads that manifest at startup (server/lib/assets.ts) and renders
 * `<link href=...>` with the hashed name, then serves it with
 * `Cache-Control: public, max-age=31536000, immutable`. The stable
 * `/style.css` alias is kept so caches that already fetched the old path and
 * ad-hoc references keep resolving — the *referenced* URL is what changes.
 *
 * Tailwind doesn't emit a hash, so we hash the compiled bytes ourselves.
 * 16 hex chars = 64 bits; birthday-bound collision odds over a century of
 * three rebuilds a day are ~2×10⁻⁹ — negligible.
 *
 * Old `style-*.css` files are pruned so `public/` doesn't accumulate junk
 * across rebuilds (the stable name always survives).
 *
 * NOTE: the Tailwind CLI only emits the stable file. If your entry file (or
 * the `@source` globs it uses) changes, `main.css` itself won't have changed
 * but the compiled output will, so the hash will differ and old cached assets
 * are naturally invalidated. This mirrors webpack's contenthash behaviour.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, rm, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'

const ROOT = path.resolve(import.meta.dir, '..')
const TAILWIND_IN = path.join(ROOT, 'main.css')
const PUBLIC_DIR = path.join(ROOT, 'public')
const STYLE_STABLE = path.join(PUBLIC_DIR, 'style.css')
const MANIFEST = path.join(PUBLIC_DIR, '.asset-manifest.json')
const STABLE_URL = '/style.css'
const PREFIX = 'style-'
const HASH_LEN = 16

/** Run the Tailwind CLI (mirror of `bun run build:css`). */
function runTailwind(): void {
  const res = spawnSync(
    'bunx',
    ['@tailwindcss/cli', '-i', TAILWIND_IN, '-o', STYLE_STABLE],
    { stdio: 'pipe', encoding: 'utf8', shell: true },
  )
  if (res.status !== 0) {
    throw new Error(`build:css failed: ${res.stderr || res.stdout}`)
  }
}

runTailwind()

const compiled = await readFile(STYLE_STABLE)
const hashed = `${PREFIX}${createHash('sha256').update(compiled).digest('hex').slice(0, HASH_LEN)}.css`

await writeFile(path.join(PUBLIC_DIR, hashed), compiled)
await writeFile(
  MANIFEST,
  JSON.stringify({ [STABLE_URL]: `/${hashed}` }, null, 2) + '\n',
)

// Prune older fingerprinted builds; keep the stable alias and this build.
for (const e of await readdir(PUBLIC_DIR, { withFileTypes: true })) {
  if (!e.isFile()) continue
  if (e.name.startsWith(PREFIX) && e.name.endsWith('.css') && e.name !== hashed) {
    await rm(path.join(PUBLIC_DIR, e.name))
  }
}

console.log(`Fingerprinted CSS -> /${hashed}`)
