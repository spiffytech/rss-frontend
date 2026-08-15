FROM oven/bun:1.3.14 AS base
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---- builder: install full deps (tailwind CLI is a devDependency) and compile
# the one build artifact we have — public/style.css from main.css + server TSX.
FROM base AS builder
WORKDIR /home/bun/app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save
COPY . .
RUN bun run build:css

# ---- runtime: production deps only, then the server + freshly built CSS.
FROM base
WORKDIR /home/bun/app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --no-save --production
# tsconfig.json is read by Bun at runtime for the hono/jsx transform.
COPY tsconfig.json ./
COPY server server
COPY public public
COPY --from=builder /home/bun/app/public/style.css public/style.css
USER bun
# Bun auto-serves the default-exported Hono app on $PORT (default 3000).
CMD ["bun", "run", "server/hono.tsx"]
