import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { auditLogs, failAudited, recordAudit } from "@/lib/audit";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";

export const dynamic = "force-dynamic";

const DELETE_CHUNK = 500;

const bodySchema = z.object({ batch_id: z.string().uuid() });

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * [Web Admin] 억제 가져오기 배치 되돌리기.
 *
 * 잘못된 CSV 를 올리면 수천 명이 한 번에 차단된다. 한 줄씩 푸는 건 현실적으로 불가능하므로
 * 배치 단위로 되돌린다. 무엇이 그 배치인지는 가져오기 때 **같은 트랜잭션**으로 적어 둔
 * 감사 항목(`suppression.import`, target = batch id)의 `insertedIds` 가 알려준다.
 *
 * - 그 배치가 넣은 행만 지운다. 이미 있던 억제(건너뛴 행)는 건드리지 않는다 —
 *   같은 사람이 원래부터 수신거부였다면 되돌리기로 다시 발송 대상이 되어서는 안 된다.
 * - 두 번 되돌릴 수 없다(409). 되돌린 뒤 누군가 같은 사람을 다시 억제했는데
 *   그 행까지 지워 버리는 사고를 막는다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "suppression.import.revert", "suppression_batch", authz);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = bodySchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const batchId = parsed.data.batch_id;

  const db = getDb();
  // projectId 를 함께 건다 — batch id 만으로 찾으면 타 테넌트의 배치를 되돌릴 수 있다
  const entries = await db
    .select({ action: auditLogs.action, metadata: auditLogs.metadata })
    .from(auditLogs)
    .where(and(eq(auditLogs.projectId, id), eq(auditLogs.targetId, batchId)));

  const imported = entries.find((e) => e.action === "suppression.import");
  if (!imported) return fail("Import batch not found", 404);
  if (entries.some((e) => e.action === "suppression.import.revert")) {
    return fail("This import batch was already reverted", 409, { code: "import_already_reverted" });
  }

  const entry = imported.metadata?.insertedIds as { after?: unknown } | undefined;
  const raw = entry?.after;
  const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
  if (ids.length === 0) return fail("Import batch has no rows to revert", 409, { code: "import_empty" });

  let deleted = 0;
  await db.transaction(async (tx) => {
    for (const part of chunk(ids, DELETE_CHUNK)) {
      const rows = await tx
        .delete(suppressions)
        .where(and(eq(suppressions.projectId, id), inArray(suppressions.id, part)))
        .returning({ id: suppressions.id });
      deleted += rows.length;
    }
    await recordAudit({
      db: tx,
      projectId: id,
      actor: authz.ctx,
      action: "suppression.import.revert",
      targetType: "suppression_batch",
      targetId: batchId,
      diff: {
        // 그 사이 손으로 지운 행이 있으면 수가 다르다 — 숨기지 않고 둘 다 남긴다
        suppressed: { before: ids.length, after: ids.length - deleted },
        removed: { before: 0, after: deleted },
      },
    });
  });

  return ok({ batch_id: batchId, removed: deleted, expected: ids.length });
}
