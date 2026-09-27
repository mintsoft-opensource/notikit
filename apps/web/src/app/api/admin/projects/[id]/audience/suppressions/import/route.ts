import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { auditLogs, failAudited, newBatchId, recordAudit } from "@/lib/audit";
import { PayloadTooLargeError } from "@/lib/read-json";
import {
  SUPPRESSION_REASONS,
  dedupeRows,
  parseSuppressionCsv,
  parseSuppressionJson,
  type ImportRow,
  type ParseResult,
  type SuppressionReason,
} from "@/lib/suppression-import";

export const dynamic = "force-dynamic";

const MAX_BYTES = 3 * 1024 * 1024;
const LOOKUP_CHUNK = 1000;
const INSERT_CHUNK = 500;

async function readTextLimited(req: Request): Promise<string> {
  const cl = req.headers.get("content-length");
  if (cl && Number(cl) > MAX_BYTES) throw new PayloadTooLargeError();
  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function parseBody(contentType: string, text: string): ParseResult {
  if (!contentType.includes("json")) return parseSuppressionCsv(text);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON" };
  }
  if (Array.isArray(body)) return parseSuppressionJson(body);
  const o = (body ?? {}) as { rows?: unknown; csv?: unknown; reason?: unknown };
  const reason: SuppressionReason =
    typeof o.reason === "string" && (SUPPRESSION_REASONS as readonly string[]).includes(o.reason)
      ? (o.reason as SuppressionReason)
      : "manual";
  if (typeof o.csv === "string") return parseSuppressionCsv(o.csv, reason);
  return parseSuppressionJson(o.rows, reason);
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** 이미 억제된 대상 — 같은 대상을 두 번 넣으면 해제할 때 하나만 풀려 계속 막힌다 */
async function existingKeys(db: ReturnType<typeof getDb>, projectId: string, rows: ImportRow[]): Promise<Set<string>> {
  const keys = new Set<string>();
  const ids = rows.flatMap((r) => (r.externalId ? [r.externalId] : []));
  const tokens = rows.flatMap((r) => (r.token ? [r.token] : []));
  for (const part of chunk(ids, LOOKUP_CHUNK)) {
    const found = await db
      .select({ v: suppressions.externalId })
      .from(suppressions)
      .where(and(eq(suppressions.projectId, projectId), inArray(suppressions.externalId, part)));
    for (const f of found) if (f.v) keys.add(`u:${f.v}`);
  }
  for (const part of chunk(tokens, LOOKUP_CHUNK)) {
    const found = await db
      .select({ v: suppressions.token })
      .from(suppressions)
      .where(and(eq(suppressions.projectId, projectId), inArray(suppressions.token, part)));
    for (const f of found) if (f.v) keys.add(`t:${f.v}`);
  }
  return keys;
}

/** 화면에 내놓는 최근 배치 수. 되돌리기는 사고 직후에 누르는 것이라 더 깊이 볼 이유가 없다. */
const RECENT_BATCHES = 5;

/** diff 항목(`{before, after}`)의 after 를 수로 읽는다 — 모양이 다르면 0 */
function afterCount(metadata: Record<string, unknown> | null, field: string): number {
  const entry = metadata?.[field] as { after?: unknown } | undefined;
  return typeof entry?.after === "number" ? entry.after : 0;
}

/**
 * [Web Admin] 최근 가져오기 배치 목록 — 되돌리기 버튼이 가리킬 대상.
 *
 * 억제 테이블에는 배치 칼럼이 없다(스키마 소유가 다르다). 가져오기가 **같은 트랜잭션**으로
 * 적은 감사 항목이 그 대장이므로 여기서도 감사 로그를 읽는다.
 *
 * 되돌린 배치도 숨기지 않고 표시만 바꾼다 — 목록에서 사라지면 "되돌렸다"와 "그런 배치가
 * 없다"가 구분되지 않아 운영자가 같은 CSV 를 다시 올린다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const rows = await db
    .select({
      action: auditLogs.action,
      actor: auditLogs.actor,
      targetId: auditLogs.targetId,
      metadata: auditLogs.metadata,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.projectId, id),
        eq(auditLogs.targetType, "suppression_batch"),
        inArray(auditLogs.action, ["suppression.import", "suppression.import.revert"])
      )
    )
    .orderBy(desc(auditLogs.createdAt))
    // 되돌리기 항목이 섞여 오므로 넉넉히 읽고 가져오기 5건으로 자른다
    .limit(RECENT_BATCHES * 4);

  const reverted = new Set(
    rows.flatMap((r) => (r.action === "suppression.import.revert" && r.targetId ? [r.targetId] : []))
  );
  const batches = rows
    .filter((r) => r.action === "suppression.import" && r.targetId)
    .slice(0, RECENT_BATCHES)
    .map((r) => ({
      batch_id: r.targetId as string,
      added: afterCount(r.metadata, "added"),
      skipped: afterCount(r.metadata, "skipped"),
      actor: r.actor,
      created_at: r.createdAt.toISOString(),
      reverted: reverted.has(r.targetId as string),
    }));

  return ok({ batches });
}

/**
 * [Web Admin] 억제 목록 일괄 가져오기 — 최대 5,000행.
 *
 * 본문: `text/csv`(헤더 `user_id` 또는 `token`, 선택 `reason`) 또는 JSON
 * (`[{ user_id | token, reason? }]`, `{ rows: [...] }`, `{ csv: "..." }`).
 * 형식이 틀린 행·파일 안 중복·이미 억제된 대상은 건너뛰고 수만 돌려준다.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "suppression.import", "suppression_batch", authz);

  let text: string;
  try {
    text = await readTextLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid body", 400);
  }

  const parsed = parseBody(req.headers.get("content-type") ?? "", text);
  if ("error" in parsed) return fail(parsed.error, 422);

  const { unique, duplicates } = dedupeRows(parsed.rows);
  const db = getDb();
  const existing = await existingKeys(db, id, unique);
  const fresh = unique.filter((r) => !existing.has(r.externalId ? `u:${r.externalId}` : `t:${r.token}`));

  // 배치 id — 이 회차로 들어간 행을 나중에 통째로 되돌리기 위한 손잡이.
  // 억제 테이블에 배치 칼럼을 둘 수 없어(스키마 소유가 다르다) 감사 항목이 그 대장 역할을 한다.
  const batchId = newBatchId();
  const insertedIds: string[] = [];

  if (fresh.length > 0) {
    await db.transaction(async (tx) => {
      for (const part of chunk(fresh, INSERT_CHUNK)) {
        const rows = await tx
          .insert(suppressions)
          .values(part.map((r) => ({ projectId: id, externalId: r.externalId, token: r.token, reason: r.reason })))
          .returning({ id: suppressions.id });
        for (const r of rows) insertedIds.push(r.id);
      }
      // **같은 트랜잭션**에 적는다. 밖에서 적으면 그 사이 프로세스가 죽었을 때
      // 5,000명이 차단된 채 배치 id 가 없어 되돌릴 방법이 사라진다.
      await recordAudit({
        db: tx,
        projectId: id,
        actor: authz.ctx,
        action: "suppression.import",
        targetType: "suppression_batch",
        targetId: batchId,
        diff: {
          // 대상(external_id·token)은 적지 않는다 — 전화번호·토큰이 섞여 들어온다.
          // 되돌리기에 필요한 건 우리가 만든 행 id 뿐이다.
          added: { before: 0, after: fresh.length },
          skipped: { before: 0, after: parsed.invalid + duplicates + (unique.length - fresh.length) },
          insertedIds: { before: null, after: insertedIds },
        },
      });
    });
  }

  return ok({
    batch_id: fresh.length > 0 ? batchId : null,
    added: fresh.length,
    skipped: parsed.invalid + duplicates + (unique.length - fresh.length),
  });
}
