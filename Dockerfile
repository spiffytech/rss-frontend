FROM oven/bun:1.4.0 AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

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
