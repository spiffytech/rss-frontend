FROM oven/bun:1.3.14 AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---- builder: install full deps (tailwind CLI is a devDependency) and
# compile+hash the CSS (scripts/fingerprint-css.ts runs tailwind itself).
FROM base AS builder
WORKDIR /home/bun/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save
COPY . .
RUN bun run build
# Build produces content-hashed CSS (public/style-*.css) + .asset-manifest.json.

# ---- runtime: production deps only, then the server + freshly built assets.
FROM base
WORKDIR /home/bun/app
ENV NODE_ENV=production
ENV prefsDbPath=/data/prefs.sqlite
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save --production
# tsconfig.json is read by Bun at runtime for the hono/jsx transform.
COPY tsconfig.json ./
COPY server server
COPY public public
COPY --from=builder /home/bun/app/public/ public/
# Per-account preference store (SQLite) — writable by the `bun` user.
RUN mkdir -p /data && chown bun:bun /data
USER bun
# Bun auto-serves the default-exported Hono app on $PORT (default 3000).
CMD ["bun", "run", "server/hono.tsx"]
