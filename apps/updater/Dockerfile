# 업데이터 — Docker 소켓을 쥐는 유일한 컨테이너.
# 여기에 들어가는 것을 최소로 유지한다. 이 이미지에서 나는 사고는 곧 호스트 장악이다.
FROM docker:27-cli

# docker compose(교체), postgresql-client(마이그레이션 전 덤프), nodejs(작업 루프)
# pg_dump 는 서버와 같은 메이저를 써야 한다 — 낮으면 덤프를 거부한다.
RUN apk add --no-cache nodejs npm postgresql16-client

WORKDIR /app
COPY apps/updater/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY apps/updater/index.mjs apps/updater/bundle-meta.mjs ./

# docker:cli 의 ENTRYPOINT(docker-entrypoint.sh)는 인자 앞에 `docker` 를 붙인다.
# 그대로 두면 CMD 가 `docker node index.mjs` 로 해석돼 스웜 도움말만 찍고 죽고,
# 컨테이너는 restart 루프를 돈다 — 업데이트 작업을 아무도 집어가지 않는다.
# 그 엔트리포인트는 dind 용 TLS 설정을 위한 것이라 소켓을 마운트하는 여기엔 필요 없다.
ENTRYPOINT []
# 루트로 돈다 — Docker 소켓 접근에 필요하다. 그래서 포트를 열지 않고,
# 바깥에서 닿을 수 있는 경로를 두지 않는다.
CMD ["node", "/app/index.mjs"]
