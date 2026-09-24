import { and, desc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { auditLogs, auditConds, parseAuditFilters, baseAction, isDenied, type AuditDiff } from "@/lib/audit";
import { beforeCursor, cursorExpr, type Cursor } from "@/lib/keyset";
import { CSV_PAGE_SIZE, CSV_ROW_LIMIT, csvHeaders, csvStream, csvTimestamp, pagedRows } from "@/lib/csv-export";

export const dynamic = "force-dynamic";

const HEADER = ["created_at", "actor", "actor_id", "action", "outcome", "target_type", "target_id", "changes"] as const;

/** 변경 내역을 한 칸에 사람이 읽을 수 있게. 값은 이미 audit.ts 에서 가려진 상태다. */
function changesText(metadata: Record<string, unknown> | null): string {
  if (!metadata) return "";
  // metadata 는 jsonb 라 타입이 느슨하다 — 우리가 쓴 { before, after } 모양만 골라 읽는다
  return Object.entries(metadata as AuditDiff)
    .map(([field, d]) => `${field}: ${JSON.stringify(d.before ?? null)} → ${JSON.stringify(d.after ?? null)}`)
    .join("; ");
}

/**
 * [Web Admin] 감사 로그 CSV 내보내기.
 *
 * 화면의 필터를 **그대로** 받는다(`parseAuditFilters` 를 목록 API 와 공유) —
 * 내려받은 파일이 화면과 다른 범위를 담으면 감사 자료로 쓸 수 없다.
 * 최대 `CSV_ROW_LIMIT` 행까지이며 그 이상은 기간을 좁혀 다시 받아야 한다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const filters = parseAuditFilters(new URL(req.url));
  const db = getDb();

  const rows = pagedRows(
    async (cursor: Cursor | null) => {
      const conds = auditConds(id, filters);
      if (cursor) conds.push(beforeCursor(auditLogs.createdAt, auditLogs.id, cursor));
      const page = await db
        .select({
          id: auditLogs.id,
          actorLabel: auditLogs.actor,
          actorId: auditLogs.actorUserId,
          action: auditLogs.action,
          targetType: auditLogs.targetType,
          targetId: auditLogs.targetId,
          diff: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
          cursorTs: cursorExpr(auditLogs.createdAt),
        })
        .from(auditLogs)
        .where(and(...conds))
        .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
        .limit(CSV_PAGE_SIZE);
      const last = page[page.length - 1];
      // 페이지가 가득 찼을 때만 다음 커서를 준다 — 덜 찼으면 그게 마지막이다
      return { rows: page, next: page.length === CSV_PAGE_SIZE && last ? { ts: last.cursorTs, id: last.id } : null };
    },
    (r) => [
      csvTimestamp(r.createdAt),
      r.actorLabel,
      r.actorId,
      baseAction(r.action),
      isDenied(r.action) ? "denied" : "ok",
      r.targetType,
      r.targetId,
      changesText(r.diff),
    ]
  );

  return new Response(csvStream({ header: HEADER, rows, limit: CSV_ROW_LIMIT }), {
    headers: csvHeaders("notikit-audit"),
  });
}
