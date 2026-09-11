import { execFileSync } from "node:child_process";
import { E2E_DATABASE_URL } from "./env";

/**
 * e2e 시작 전 마이그레이션 적용.
 *
 * webServer 명령에 붙이지 않는 이유: 로컬은 `reuseExistingServer` 라 이미 서버가 떠
 * 있으면 그 명령이 아예 실행되지 않는다. 그러면 스키마를 바꾼 뒤 e2e 를 돌릴 때
 * "DB 에 컬럼이 없어 500" 을 테스트 실패로 오해하게 된다(실제로 겪었다).
 *
 * globalSetup 은 서버 재사용 여부와 무관하게 항상 돈다. 마이그레이션은 멱등하므로
 * 매번 실행해도 안전하다.
 */
export default function globalSetup() {
  execFileSync("node", ["migrate.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL },
    stdio: "inherit",
  });
}
