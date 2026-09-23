# Notikit web — Next.js standalone 멀티스테이지
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.12.1 --activate
WORKDIR /app

# 워크스페이스 매니페스트 + lockfile 만 먼저 복사 — 소스가 바뀌어도 설치 레이어는 캐시된다.
# web 이 쓰는 워크스페이스 패키지(@notikit/license, @notikit/core)도 함께 설치해야 링크가 걸린다.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/license/package.json packages/license/
COPY packages/sdk-core/package.json packages/sdk-core/
RUN pnpm install --frozen-lockfile --filter "@notikit/web..."

FROM deps AS build
COPY packages/license packages/license
COPY packages/sdk-core packages/sdk-core
COPY apps/web apps/web
# @notikit/core 는 dist 로 배포된다 — web 타입 검사(e2e 포함)가 그 타입을 읽는다
RUN pnpm --filter @notikit/core build && pnpm --filter @notikit/web build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# 런타임은 root 가 아닌 node(이미지 기본 유저)로 — 파일도 node 소유로 복사한다.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/worker.mjs ./apps/web/worker.mjs
COPY --from=build --chown=node:node /app/apps/web/migrate.mjs ./apps/web/migrate.mjs
COPY --from=build --chown=node:node /app/apps/web/drizzle ./apps/web/drizzle

# 소스맵은 클로즈드 배포에 쓸모가 없다. 내용이 비어 있어 원본 복원은 불가능하지만,
# 굳이 고객 박스에 둘 이유도 없고 이미지만 커진다.
# Next 가 런타임에 쓰는 캐시(.next/cache — 이미지 최적화 등)는 node 가 쓸 수 있어야 한다.
RUN find . -name "*.js.map" -delete \
  && mkdir -p apps/web/.next/cache \
  && chown node:node /app apps/web/.next apps/web/.next/cache

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
