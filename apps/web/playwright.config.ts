import { defineConfig } from "@playwright/test";
import { E2E_DATABASE_URL } from "./e2e/env";

const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  // 한 번은 다시 해 본다 — 테스트들이 같은 관리자 세션과 프로젝트를 공유하고, 전체를 돌리는
  // 머신 부하에 따라 세션이 끊기거나 5초 단언이 넘칠 때가 있다(각각 단독으로는 항상 통과).
  // 재시도로 덮는 것이 아니라, 공유 세션을 테스트마다 분리하는 것이 제대로 된 해법이다.
  retries: 1,
  reporter: [["list"]],
  // 모션 최소화로 돌린다 — 다이얼로그·드로어의 나가는 애니메이션(150ms)이 부하가 걸린 머신에서
  // 늘어지면 "닫혔는가" 단언이 흔들린다. globals.css 의 prefers-reduced-motion 규칙이
  // 애니메이션을 없애므로, 이 설정은 접근성 경로를 그대로 검증하는 것이기도 하다.
  use: { baseURL, trace: "on-first-retry", contextOptions: { reducedMotion: "reduce" } },
  // 스키마 변경 후 마이그레이션을 잊어 테스트가 500 으로 깨지는 것을 막는다
  globalSetup: "./e2e/global-setup.ts",
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: `${baseURL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: E2E_DATABASE_URL,
      ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "e2e-admin-token",
      NOTIKIT_ENCRYPTION_KEY: process.env.NOTIKIT_ENCRYPTION_KEY ?? "e2e-encryption-key-32bytes-minimum",
      NODE_ENV: "production",
      COOKIE_INSECURE: "true", // http 테스트 서버 — Secure 쿠키 비활성
      APP_ORIGIN: `http://localhost:${PORT}`,
      // purge 테스트용. 워커가 안 도는 환경이라 엔드포인트를 직접 부를 때만 삭제된다.
      LOG_RETENTION_DAYS: "1",
      // 한도는 프로세스 메모리로. 공유 Redis 를 쓰면 개발 서버·이전 실행과 카운터가 섞여
      // 150개 테스트가 프로젝트를 만들다 429 를 맞는다(실제로 그렇게 깨졌다).
      // 공유 리미터 자체는 rate-limit.test.ts 가 검증한다.
      REDIS_URL: "",
    },
  },
});
