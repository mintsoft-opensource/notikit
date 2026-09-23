import { ok, fail } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";
import { sweepWebhookRetries } from "@/lib/webhooks";

export const dynamic = "force-dynamic";

/**
 * [Internal/Worker] 전 프로젝트 웹훅 재시도 스윕.
 *
 * 프로젝트마다 호출하던 것을 한 번으로 합친다 — 프로젝트가 늘어도 tick 당 요청 수가 고정이고,
 * 오래 실패한 배달이 프로젝트 순회 순서에 밀리지 않는다.
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
    return ok(
      await sweepWebhookRetries({
        limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : undefined,
      })
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Sweep failed", 500);
  }
}
