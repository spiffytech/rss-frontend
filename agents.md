
Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

This project is in a public repo.

## Untrusted feed HTML (hard rule)

Entry content is untrusted feed HTML. It is inserted **client-side only**,
through `Element.setHTML()` / DOMPurify (`src/client/display/render.ts` —
`transformEntryContent` then `sinkEntryContent`), never server-rendered and
never via `{@html}`: the Sanitizer API is DOM-time only, so a server render is
an unguarded sink. The display policy lives in one table
(`src/client/display/policy.ts`) that both sanitizer adapters read.

## Tests & checks

All commands run from `app/`:

```sh
bun test                    # unit suite (bun:test) — hermetic: in-memory DBs + fixtures,
                            # no network, never touches production data or accounts
bun run test:webview        # real-browser behavior suite (Bun.WebView → headless Chrome on
                            # Linux, WKWebView on macOS): rebuilds, boots the app, exercises
                            # the Sanitizer/display pipeline. Needs Chrome; skip on a bare box.
bunx tsc --noEmit           # types
bun run check               # svelte-check (components + svelte-kit sync)
```

Non-obvious tooling facts (all learned the hard way):

- `typescript` is pinned to `^6` — TS 7 (native) removed `ts.sys`, which breaks `svelte-kit sync`
  and svelte-check (upstream: sveltejs/language-tools#3063). Don't bump it until that closes.
- Dev/build must run under Bun (`bun --bun vite …`, already wired into `bun run dev|build`):
  SvelteKit's route-analysis worker uses a plain ESM loader that can't load `bun:*` specifiers,
  and `bun:sqlite` stays lazy (`createRequire`) in `src/server/db/index.ts` for the same reason.
- Never name a local `state` in a `.svelte` file (the codebase uses `appState`) — Svelte parses
  `$state` as a store subscription then (`store_rune_conflict`).
- `test/webview.test.ts` is the only place the display pipeline is proven against a real
  browser engine — run it after touching `src/client/display/`.
- Want a throwaway login for manual poking? `bun run scripts/seed-test-user.ts` seeds a
  passwordless `test` user from the real account's feeds (`--delete` removes it). Never keep
  a passwordless account on the public login form.

The NEW app lives in `app/` — `cd app && bun run dev` (it reads `../data/reader.sqlite`).
The repo-root `bun run dev` does the same thing (`cd app && bun run dev`), so both
commands boot the reader. The old Vue scripts (`vite`, `dev:server`) still exist
but point at the retired Miniflux app; they go at the final flatten/rename.

The scheduler lives in `app/src/server/scheduler/` and is ON by default: it
polls feeds on learned bells, appends arrivals to the open view, and reports
`/health` 503 when a tick goes stale. Pause at runtime with
`touch data/.scheduler-off`; disable with `SCHEDULER_ENABLED=0`. Design doc +
port deltas: `docs/feed-scheduler.md`.
