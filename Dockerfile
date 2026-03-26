FROM node:22-slim AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Build
FROM deps AS build
COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# Production
FROM base AS prod
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist

ENV PORT=3000
ENV BASE_URL=http://localhost:3000
ENV MIN_SENDABLE=1000
ENV MAX_SENDABLE=100000000000
ENV INVOICE_TIMEOUT_MS=30000

EXPOSE 3000

CMD ["node", "dist/cli.js"]
