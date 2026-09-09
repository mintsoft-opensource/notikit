import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { rateLimit } from "@/lib/rate-limit";
import { checkProjectTokens } from "@/lib/token-health";

export const dynamic = "force-dynamic";

/**
 * [Web Admin/Worker] 죽은 토큰 청소 — FCM dry-run 으로 활성 토큰을 검증하고
 * 등록 해제된 것을 비활성화한다. 검증만 하므로 유저에게 알림이 뜨지 않는다.
 *
 * 프로젝트 전체 토큰을 도는 무거운 작업이라 분당 2회로 제한.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);
  if (!rateLimit(`tokens:check:${id}`, 2, 60_000)) return fail("Rate limit exceeded", 429);

  try {
    return ok(await checkProjectTokens(id));
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Token check failed", 500);
  }
}
