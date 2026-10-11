# Reader — SvelteKit (adapter-bun): one Bun process serving app + API.
# Build context is this directory (app/); see .dockerignore (import-dump/
# and data/ must never enter an image).
FROM oven/bun:1.4 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# adapter-bun output: build/index.js is the serve entry
COPY --from=builder /app/build ./build
# drizzle migrations (MIGRATIONS_DIR points here at runtime)
COPY drizzle ./drizzle
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "build/index.js"]
