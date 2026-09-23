import { ok, fail } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";
import { getRateLimitHealth } from "@/lib/rate-limit";
import { getWebhookHealth, sweepWebhookRetries } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/**
 * [Internal/Worker] 전 프로젝트 웹훅 재시도 스윕.
 *
 * 프로젝트마다 호출하던 것을 한 번으로 합친다 — 프로젝트가 늘어도 tick 당 요청 수가 고정이고,
 * 오래 실패한 배달이 프로젝트 순회 순서에 밀리지 않는다.
 *
 * 응답에는 스윕 결과와 함께 이 인스턴스의 **관측 카운터**를 실어 보낸다: 포기한 배달(dead letter)
 * 총량과, 공유 rate limit 이 인메모리로 떨어진 횟수. 워커가 주기적으로 부르는 유일한 내부
 * 엔드포인트라, 별도 지표 파이프라인 없이도 두 가지 조용한 실패가 로그에 남는다.
 *
 * 인증: `ADMIN_TOKEN`(서버-투-서버)만. 콘솔 세션 쿠키로는 열리지 않는다.
 */
export async function POST(req: Request) {
  const ctx = await getAuthContext(req);
  if (!ctx?.superadmin) return fail("Unauthorized", 401);

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit"));
  const budgetMs = Number(url.searchParams.get("budget_ms"));

  try {
    const result = await sweepWebhookRetries({
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
    });
    const rl = getRateLimitHealth();
    return ok({
      ...result,
      webhooks: getWebhookHealth(),
      rateLimit: { shared: rl.enabled, connected: rl.connected, fallbacks: rl.fallbacks, timeouts: rl.timeouts, degradedSince: rl.degradedSince },
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Sweep failed", 500);
  }
}
