import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createNextIntlPlugin from "next-intl/plugin";
import { createRequire } from "node:module";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// 실행 중인 버전을 화면에 띄우려면 런타임에 알아야 한다. standalone 빌드에는
// package.json 이 따라가지 않으므로 빌드 시점에 박는다.
const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // 모노레포 — 트레이싱 루트를 notikit 루트로 고정(중복 lockfile 경고 방지)
  outputFileTracingRoot: path.join(dirname, "..", ".."),
  env: { NOTIKIT_VERSION: version },
};

export default withNextIntl(nextConfig);
