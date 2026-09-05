# Notikit web — Next.js standalone 멀티스테이지
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.12.1 --activate
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .
RUN pnpm --filter @notikit/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public
COPY --from=build /app/apps/web/worker.mjs ./apps/web/worker.mjs
COPY --from=build /app/apps/web/migrate.mjs ./apps/web/migrate.mjs
COPY --from=build /app/apps/web/drizzle ./apps/web/drizzle
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
