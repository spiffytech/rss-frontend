FROM oven/bun:1.4.2 AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# REAL NODE IS REQUIRED. oven/bun ships none -- the `node` on its PATH is
# bun-node-fallback-bin/node, a Bun impersonator that does not even answer
# --version. vue-tsc's bin is `#!/usr/bin/env node`, so under that shim
# TypeScript's language-service plugins never load: the Vue plugin never
# registers, `.vue` stops being a resolvable file type, and every `.ts` import
# of a component fails with TS2307 ("Module name './App.vue' was not resolved",
# after stripping the extension and looking for App.vue.ts).
# `bun --bun` does NOT help -- that is the same runtime. Real Node does.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# ---- builder: install full deps and build the Vue SPA (Vite emits hashed
# JS/CSS into dist/ with its own content-hashing — no manual fingerprinting).
FROM base AS builder
WORKDIR /home/bun/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save
COPY . .
RUN bun run build

# ---- runtime: production deps only, then the server + freshly built dist.
FROM base
WORKDIR /home/bun/app
ENV NODE_ENV=production
ENV prefsDbPath=/data/prefs.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save --production
COPY tsconfig.json ./
COPY src/server src/server
COPY src/shared src/shared
COPY --from=builder /home/bun/app/dist/ dist/
COPY public public
# Per-account preference store (SQLite) — writable by the `bun` user.
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "run", "src/server/index.ts"]
