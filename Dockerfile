FROM node:22-slim AS base
# Pin pnpm to a version satisfying engines.pnpm (>=10.25.0 <11) and matching the
# pnpm-10 lockfile format; `pnpm@latest` now resolves to 11.x which the engines field rejects.
RUN corepack enable && corepack prepare pnpm@10.29.2 --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Build
FROM deps AS build
COPY tsconfig.json tsconfig.ui.json vite.config.ts tsup.config.ts ./
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN pnpm build

# Production
FROM base AS prod
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist

ENV PORT=3000
ENV ADMIN_PORT=3001
ENV ADMIN_BIND=0.0.0.0
ENV BASE_URL=http://localhost:3000
ENV MIN_SENDABLE=1000
ENV MAX_SENDABLE=100000000000
ENV INVOICE_TIMEOUT_MS=30000

EXPOSE 3000 3001
VOLUME ["/data"]

CMD ["node", "--experimental-sqlite", "dist/cli.js"]
