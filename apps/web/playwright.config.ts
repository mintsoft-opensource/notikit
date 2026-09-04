import { defineConfig } from "@playwright/test";

const PORT = process.env.E2E_PORT ?? "3100";
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL, trace: "on-first-retry" },
  webServer: {
    command: `npx next start --port ${PORT}`,
    url: `${baseURL}/api/health`,
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://notikit:notikit@localhost:5432/notikit",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN ?? "e2e-admin-token",
      NOTIKIT_ENCRYPTION_KEY: process.env.NOTIKIT_ENCRYPTION_KEY ?? "e2e-encryption-key-32bytes-minimum",
      NODE_ENV: "production",
    },
  },
});
