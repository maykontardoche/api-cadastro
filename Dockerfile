# syntax=docker/dockerfile:1

# Build: full dependencies, Prisma client generation and TypeScript compilation. The compose
# `migrate` service also runs from this stage, because `prisma migrate deploy` needs the CLI.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs `prisma generate`, which only needs the schema (no database).
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Runtime: production dependencies and the compiled app only (the generated client is compiled
# into dist/). `--omit=optional` drops the Prisma CLI and TypeScript, which @prisma/client lists
# as optional peers (npm marks them devOptional, so `--omit=dev` alone keeps them), and
# pg-cloudflare, which pg only loads on Cloudflare Workers. Scripts are skipped: postinstall
# needs the Prisma CLI, and argon2 loads its prebuilt binary without one.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
# Files stay owned by root and read-only to the process.
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Exec form: node is PID 1 and receives SIGTERM directly; server.ts shuts down gracefully.
CMD ["node", "dist/server.js"]
