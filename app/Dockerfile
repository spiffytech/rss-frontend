# Reader — Solid 2 start mode + Bun.serve: one Bun process serving app + RPC.
# Build context is this directory (app/); see .dockerignore (import-dump/ and
# data/ must never enter an image).
FROM oven/bun:1.4.4 AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.4.4
WORKDIR /app
ENV NODE_ENV=production
# The cluster routes every service to :3000; keep that the image default so a
# compose entry that forgets PORT still works.
ENV PORT=3000
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
# server.ts runs from source under Bun — it imports src/startup (the scheduler)
# and the data layer — and serves the built Solid app from dist/.
COPY server.ts tsconfig.json ./
COPY src ./src
COPY --from=builder /app/dist ./dist
# drizzle migrations (server.ts points MIGRATIONS_DIR here)
COPY drizzle ./drizzle
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "server.ts"]
