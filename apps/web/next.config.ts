import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // 모노레포 — 트레이싱 루트를 notikit 루트로 고정(중복 lockfile 경고 방지)
  outputFileTracingRoot: path.join(dirname, "..", ".."),
};

export default withNextIntl(nextConfig);
