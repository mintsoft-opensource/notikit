import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { suppressions } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
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
  if (!authz.ok) return fail(authz.error, authz.status);

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

  if (fresh.length > 0) {
    await db.transaction(async (tx) => {
      for (const part of chunk(fresh, INSERT_CHUNK)) {
        await tx.insert(suppressions).values(
          part.map((r) => ({ projectId: id, externalId: r.externalId, token: r.token, reason: r.reason }))
        );
      }
    });
  }

  return ok({ added: fresh.length, skipped: parsed.invalid + duplicates + (unique.length - fresh.length) });
}
