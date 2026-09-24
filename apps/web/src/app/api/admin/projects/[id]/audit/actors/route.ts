import { and, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { auditLogs, auditConds } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** 드롭다운 상한. 넘어가면 자유 입력으로 찾는다 — 목록 자체가 무한히 길어지면 고르기가 더 어렵다. */
const MAX_ACTORS = 200;

/**
 * [Web Admin] 감사 로그 행위자 목록 — 필터 드롭다운용.
 *
 * 현재 org 멤버가 아니라 **이 프로젝트에 실제로 기록을 남긴 사람**을 준다.
 * 멤버 목록으로 채우면 이미 탈퇴한 사람이 남긴 변경을 고를 수 없다 —
 * 감사에서 가장 보고 싶은 게 대개 그쪽이다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rows = await getDb()
    .selectDistinct({ actorId: auditLogs.actorUserId, actorLabel: auditLogs.actor })
    .from(auditLogs)
    // 목록과 같은 범위(프로젝트 행 + org 전역 행)여야 드롭다운에 없는 행위자가 목록에 뜨지 않는다
    .where(and(...auditConds(id, { action: null, actor: null, from: null, to: null })))
    .orderBy(sql`${auditLogs.actor} asc`)
    .limit(MAX_ACTORS);

  // 필터 값은 uuid 가 있으면 uuid(이메일이 바뀌어도 같은 사람), 없으면 라벨(system/superadmin)
  return ok({ actors: rows.map((r) => ({ value: r.actorId ?? r.actorLabel, label: r.actorLabel })) });
}
