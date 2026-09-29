#!/usr/bin/env node
/**
 * 이 릴리스의 `hasMigrations` 를 판정할 기준 태그 — 같은 채널에서 현재보다 **낮은** 태그 중 가장 높은 것.
 *
 * `git tag --sort=-v:refname` 을 쓰지 않는 이유: git 은 v1.3.0-beta.1 을 v1.3.0 보다 위로
 * 올린다. 그러면 1.3.0 의 매니페스트가 beta.1 과만 비교돼, 1.2.0 → 1.3.0 사이의 마이그레이션이
 * 베타에 들어 있었다면 stable 고객에게 "마이그레이션 없음" 으로 나가고 백업을 건너뛴다.
 *
 * 채널은 release.yml 과 같은 규칙이다 — 태그에 `-` 가 있으면 beta, 없으면 stable.
 *
 *   node tools/release/previous-tag.mjs 1.3.0      # git tag 목록에서 골라 출력(없으면 빈 줄)
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { cmp, semver } from "../../apps/update-server/catalog.mjs";

const isPre = (v) => (semver(v)?.pre.length ?? 0) > 0;

export function previousTag(tags, current) {
  const pre = isPre(current);
  const candidates = tags.filter((t) => semver(t) && isPre(t) === pre && cmp(t, current) < 0);
  candidates.sort((a, b) => cmp(b, a));
  return candidates[0] ?? "";
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const current = process.argv[2];
  if (!semver(current)) {
    console.error("사용법: previous-tag.mjs <버전>");
    process.exit(1);
  }
  const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" }).split("\n").filter(Boolean);
  console.log(previousTag(tags, current));
}
