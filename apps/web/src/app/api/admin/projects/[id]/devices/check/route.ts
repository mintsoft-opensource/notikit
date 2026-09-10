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
  // min_interval_hours 를 주면 그 안에 이미 검사된 프로젝트는 건너뛴다.
  // 야간 스윕에서 워커가 반복 호출하거나 여러 대가 동시에 돌아도 하루 1회만 수행된다.
  // 검증은 레이트리밋보다 먼저 — 잘못된 입력이 비싼 스윕의 예산을 소모할 이유가 없다.
  const url = new URL(req.url);
  const raw = url.searchParams.get("min_interval_hours");
  const parsed = raw === null ? undefined : Number(raw);
  if (parsed !== undefined && (!Number.isFinite(parsed) || parsed < 0 || parsed > 24 * 30)) {
    return fail("min_interval_hours must be between 0 and 720", 422);
  }

  // partial 스윕은 완주까지 연속 호출되므로 이어받기를 막지 않을 만큼 여유를 둔다.
  // 실제 중복 방지는 레이트리밋이 아니라 DB CAS 클레임이 담당한다.
  if (!rateLimit(`tokens:check:${id}`, 30, 60_000)) return fail("Rate limit exceeded", 429);

  try {
    return ok(await checkProjectTokens(id, { minIntervalHours: parsed }));
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Token check failed", 500);
  }
}
