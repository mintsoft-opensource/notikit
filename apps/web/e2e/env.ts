/**
 * e2e 실행 환경 — globalSetup 과 webServer 가 **같은 DB** 를 보게 하는 단일 출처.
 *
 * 나뉘어 있으면 마이그레이션은 A 에, 서버는 B 에 붙어 원인을 찾기 어려운 실패가 난다.
 */
export const E2E_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://notikit:notikit@localhost:5432/notikit_e2e";
