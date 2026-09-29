#!/usr/bin/env node
/**
 * 릴리스 매니페스트 생성.
 *
 * `hasMigrations` 를 **사람이 적지 않는다.** 손으로 적으면 언젠가 틀리고, 틀리는
 * 날은 스키마가 백업 없이 바뀌는 날이다. 이전 태그와 drizzle 저널을 비교해 정한다.
 *
 * 이 값은 **같은 채널의 직전 태그**(previous-tag.mjs)와의 차이다. 중간 버전을 건너뛰는
 * 설치는 이 플래그 하나로 판정할 수 없다 — 업데이트 서버가 설치 버전부터 대상까지의
 * 릴리스를 모두 OR 해서 내려보낸다(apps/update-server/catalog.mjs hasMigrationsSince).
 *
 *   node tools/release/manifest.mjs --version 1.2.0 --previous 1.1.0 \
 *     --image registry.example.com/notikit --digest sha256:… > releases/1.2.0.json
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const f = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (argv[i]?.startsWith("--")) f[argv[i].slice(2)] = argv[i + 1];
}

for (const required of ["version", "image", "digest"]) {
  if (!f[required]) {
    console.error(`--${required} 가 필요합니다`);
    process.exit(1);
  }
}
if (!/^sha256:[a-f0-9]{64}$/.test(f.digest)) {
  console.error("--digest 는 sha256:… 형식이어야 합니다");
  process.exit(1);
}

const JOURNAL = "apps/web/drizzle/meta/_journal.json";

function tagsOf(ref) {
  try {
    const raw = ref
      ? execFileSync("git", ["show", `${ref}:${JOURNAL}`], { encoding: "utf8" })
      : readFileSync(JOURNAL, "utf8");
    return new Set(JSON.parse(raw).entries.map((e) => e.tag));
  } catch {
    return null; // 이전 태그가 없다(첫 릴리스)
  }
}

const now = tagsOf(null);
const before = f.previous ? tagsOf(`v${f.previous.replace(/^v/, "")}`) : null;

// 이전을 못 읽으면 "없다"고 단정하지 않는다. 모르면 있다고 보고 백업을 뜬다 —
// 틀렸을 때의 비용이 한쪽으로만 크다.
const added = before ? [...now].filter((t) => !before.has(t)) : [...now];
const hasMigrations = before === null ? true : added.length > 0;

const manifest = {
  version: f.version.replace(/^v/, ""),
  channel: f.channel ?? "stable",
  image: f.image,
  digest: f.digest,
  hasMigrations,
  ...(f.minUpgradeFrom ? { minUpgradeFrom: f.minUpgradeFrom.replace(/^v/, "") } : {}),
  notes: f.notes ?? "",
  publishedAt: f.publishedAt ?? new Date().toISOString(),
  ...(added.length > 0 ? { migrations: added } : {}),
};

console.log(JSON.stringify(manifest, null, 2));
if (before === null && f.previous) {
  console.error(`[manifest] 경고: v${f.previous} 의 저널을 읽지 못해 마이그레이션이 있다고 가정했습니다`);
}
