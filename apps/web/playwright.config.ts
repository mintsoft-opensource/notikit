import { defineConfig } from "@playwright/test";
import { E2E_DATABASE_URL } from "./e2e/env";

const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, trace: "on-first-retry" },
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
    },
  },
});
