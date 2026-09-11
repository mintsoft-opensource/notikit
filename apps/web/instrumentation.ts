/**
 * 부팅 시 필수 설정 검증 — Next 가 서버 시작 때 한 번 호출한다.
 *
 * 이전에는 web 만 지연 검증이었다(worker·updater·update-server 는 시작 시 거부).
 * 그래서 `NOTIKIT_ENCRYPTION_KEY` 가 없어도 컨테이너가 정상 기동하고 `/api/health`
 * 까지 통과했다. 업데이터의 waitHealthy() 는 그 엔드포인트만 보므로, **설정이 깨진
 * 인스턴스가 "성공한 업데이트"로 기록**됐다. 고장은 한참 뒤 첫 로그인이나 첫 발송에서
 * 드러난다 — 온프렘에서 가장 비싼 형태의 실패다.
 *
 * 실제 검증은 별도 모듈에 두고 **동적 import** 한다. 같은 파일에 두면 `process.exit`
 * 이 Edge 번들에도 딸려 들어가 빌드 경고가 난다(Edge 에는 그 API 가 없다).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  await (await import("./src/lib/verify-env")).verifyEnvOrExit();
}
