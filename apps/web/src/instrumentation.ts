/**
 * Next.js 서버 부팅 훅 — 요청과 무관하게 1회 실행.
 * 대시보드를 아무도 열지 않아도 호스트 메트릭이 계속 쌓이도록 여기서 적재기를 켠다.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startMetricsPersistence } = await import("@/lib/metrics-store");
  startMetricsPersistence();
}
