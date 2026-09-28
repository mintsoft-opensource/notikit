# Notikit web — Next.js standalone 멀티스테이지
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@8.12.1 --activate
WORKDIR /app

# 워크스페이스 매니페스트 + lockfile 만 먼저 복사 — 소스가 바뀌어도 설치 레이어는 캐시된다.
# web 이 쓰는 워크스페이스 패키지(@notikit/license)도 함께 설치해야 링크가 걸린다.
FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/license/package.json packages/license/
RUN pnpm install --frozen-lockfile --filter "@notikit/web..."

FROM deps AS build
COPY packages/license packages/license
COPY apps/web apps/web
RUN pnpm --filter @notikit/web build

# migrate.mjs 는 Next 의 트레이싱 대상이 아니다. Next 는 postgres/drizzle-orm 을 서버
# 번들 안으로 말아 넣고 standalone 의 node_modules 에는 남기지 않으므로, 런타임 이미지에서
# `node apps/web/migrate.mjs` 가 ERR_MODULE_NOT_FOUND 로 죽는다 — 개발용 compose 는
# `target: build` 로 그 문제를 피해 가지만 레지스트리 이미지에는 그럴 방법이 없다.
# lockfile 이 고른 **그 버전**을 심볼릭 링크를 풀어(-L) 따로 모아 런타임으로 넘긴다.
# 둘 다 런타임 의존성이 없어서 디렉터리 두 개면 끝난다.
RUN mkdir -p /migrate-deps \
  && cp -RL apps/web/node_modules/postgres apps/web/node_modules/drizzle-orm /migrate-deps/

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Next standalone 의 server.js 는 `process.env.HOSTNAME` 에 바인드한다. Docker 는 그 값을
# 컨테이너 ID 로 채우므로, 그대로 두면 eth0 주소에만 붙고 **루프백이 열리지 않는다**.
# 포트 매핑은 그래도 동작해 겉보기엔 멀쩡하지만, 컨테이너 안에서 도는 HEALTHCHECK 는
# 127.0.0.1 로 붙지 못해 전부 실패한다. 모든 인터페이스에 바인드시킨다.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
# 런타임은 root 가 아닌 node(이미지 기본 유저)로 — 파일도 node 소유로 복사한다.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
COPY --from=build --chown=node:node /app/apps/web/worker.mjs ./apps/web/worker.mjs
COPY --from=build --chown=node:node /app/apps/web/migrate.mjs ./apps/web/migrate.mjs
COPY --from=build --chown=node:node /app/apps/web/drizzle ./apps/web/drizzle
# migrate.mjs 가 쓰는 두 패키지. standalone 이 이미 만들어 둔 apps/web/node_modules(next)
# 옆에 합쳐진다 — 그래야 `node apps/web/migrate.mjs` 가 이 이미지 그대로 돈다.
COPY --from=build --chown=node:node /migrate-deps ./apps/web/node_modules

# 소스맵은 운영 이미지에 쓸모가 없다(원본은 공개 저장소에 있다). 두면 이미지만 커진다.
# Next 가 런타임에 쓰는 캐시(.next/cache — 이미지 최적화 등)는 node 가 쓸 수 있어야 한다.
RUN find . -name "*.js.map" -delete \
  && mkdir -p apps/web/.next/cache \
  && chown node:node /app apps/web/.next apps/web/.next/cache

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
