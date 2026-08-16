/**
 * Runtime companion to scripts/fingerprint-css.ts.
 *
 * In production the build writes `public/.asset-manifest.json` mapping the
 * stable asset path `/style.css` to a content-fingerprinted URL (e.g.
 * `/style-a1b2c3d4e5f60718.css`). The server renders `<link href>` from that
 * and serves the hashed file `immutable`, so every deploy gets a brand-new
 * URL and browsers can cache styles forever without ever going stale.
 *
 * In development there is no fingerprinting: the HTML references the stable
 * `/style.css` name, which the app serves with `Cache-Control: no-cache`, so
 * `bun run build:css:watch` keeps working exactly as before and edits are
 * always fresh on reload.
 */
import { readFileSync, existsSync } from 'node:fs'

// Anchor to this module's own location (server/lib) so the manifest path is
// right no matter what the process working directory is.
const PUBLIC_DIR = new URL('../../public/', import.meta.url).pathname
const MANIFEST = new URL('../../public/.asset-manifest.json', import.meta.url).pathname
const DEFAULT_CSS_URL = '/style.css'

export function cssUrl(): string {
  if (process.env.NODE_ENV !== 'production') {
    return DEFAULT_CSS_URL
  }
  try {
    if (existsSync(MANIFEST)) {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, string>
      const url = manifest['/style.css']
      // If the fingerprinted file is missing (e.g. fresh checkout before the
      // first build), fall back to the stable alias we also ship.
      if (typeof url === 'string' && url.startsWith('/')) {
        if (!existsSync(PUBLIC_DIR + url.slice(1))) {
          return DEFAULT_CSS_URL
        }
        return url
      }
    }
  } catch {
    // Unreadable/corrupt manifest — serve the stable alias.
  }
  return DEFAULT_CSS_URL
}
