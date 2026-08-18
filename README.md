# miniflux-frontend

A BazQux-style RSS reader frontend for a self-hosted [Miniflux](https://miniflux.app/) instance, built with **bun + hono + hono/jsx + datastar**.

## Setup

```sh
bun install
bun run build:css
```

Env vars (inline at launch — the harness forbids `.env` files):

```
minifluxUrl=https://miniflux.example.org
sessionSecret=<long random string>          # signs session cookies
prefsDbPath=./data/prefs.sqlite            # per-account pref store (SQLite)
```

`prefsDbPath` defaults to `./data/prefs.sqlite`. It holds per-account reader
preferences (keyed by Miniflux user id) that Miniflux itself can't store:
per-feed view defaults (view mode / sort / hide-read-items), plus account-wide
`hideEmptyFeeds`, collapsed categories, and disabled-auto-read feeds. In
Docker, point it at a persistent volume (see `compose.yml`).

## Run

```sh
bun run dev        # http://localhost:3007
```

## Authentication

The app is locked behind a sign-in using your Miniflux account. On login it validates via HTTP Basic against `/v1/me`, then mints a per-session Miniflux API key scoped to that user (`POST /v1/api-keys` with Basic auth), stores it in an HMAC-signed `httpOnly` cookie, and replays that key on every backend call — so the session operates as the logged-in account, not as a shared admin. Logout revokes the key on Miniflux and clears the cookie. No bootstrap/admin token is needed; each user's own credentials scope their key.

## Scripts

| Script | What it does |
|---|---|
| `bun run dev` | Start the server with watch mode (`PORT` env or 3007) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run build:css` | Tailwind v4 → `public/style.css` (stable name) |
| `bun run fingerprint:css` | Compile+hash CSS → `public/style-<sha256-16>.css` + `.asset-manifest.json` |
| `bun run build` | `fingerprint:css` (the production build step) |

## Features

- **Feed panel** — smart sections (Latest, Starred) + categories→feeds with unread counts.
- **Entry views** — expanded (full content inline) and list (compact rows), toggle with `v` or the toolbar button.
- **Reading** — the entry title opens the article in a new tab; `◉` toggles read/unread; `★` toggles star.
- **Auto-read on scroll** — unread entries that scroll into view are marked read (expanded view).
- **Keyboard shortcuts** — `j`/`k` prev/next, `m` toggle read, `s` star, `v` view mode, `Shift+A` mark all read.
- **Mark all read / Refresh / Sign out** in the `⋯` menu.
- **Navigation** — the sidebar navigates between feeds/categories via plain URL links (URL carries identity: `?feed=…&category=…&starred=1&search=…`). View mode, sort, and show-read-items are *not* URL state — they are signals toggled inline and persisted per-feed on the server, so opening a feed always restores your last view for it.

## Architecture

- `server/hono.tsx` — Hono app entry; auth middleware, login/logout routes, static + route mounting.
- `server/routes/*.tsx` — `index` renders `GET /`; `api` handles datastar SSE endpoints (per-row patches).
- `server/lib/*` — `miniflux.ts` (typed REST client, request-scoped credentials via `AsyncLocalStorage`), `auth.ts` (HMAC session cookie), `config.ts`, `prefs.ts` (per-account SQLite preference store), `assets.ts` (content-hashed CSS URL from build manifest), `util.ts`, `types.ts`.
- `server/components/*` — JSX components (Layout, TopToolbar, FeedPanel, EntryList, EntryItem).

## Notes

- Signals are the datastar default: `@post`/`@put` send all signals as a JSON body; `@get` sends them as the `datastar` query param. Route handlers parse accordingly.
- Entry rows are patched individually (`selector: '#entry-<id>'`, `mode: 'outer'`); only filter/view changes re-render the whole list.
- The datastar JS is loaded from the CDN (`datastar@v1.0.2`). Replace with a vendored copy for production.
- Static CSS is content-hashed at build time (`scripts/fingerprint-css.ts` → `public/style-<hash>.css` → `public/.asset-manifest.json`). The server renders `<link href>` from that manifest and serves the hashed file `immutable`, so a redeploy invalidates styles naturally; the stable `/style.css` alias is kept for legacy caches/offline references.
