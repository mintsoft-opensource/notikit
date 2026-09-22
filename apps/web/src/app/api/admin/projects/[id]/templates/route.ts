import { asc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { templateSchema } from "@/lib/templates";

export const dynamic = "force-dynamic";

/** 템플릿 수는 사람이 관리할 만큼이라 페이지 없이 전부 돌려준다. 상한은 폭주 방지용. */
const LIST_LIMIT = 500;

/** [Web Admin] 메시지 템플릿 목록 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const rows = await getDb()
    .select()
    .from(messageTemplates)
    .where(eq(messageTemplates.projectId, id))
    .orderBy(asc(messageTemplates.name))
    .limit(LIST_LIMIT);
  return ok({ templates: rows });
}

/** [Web Admin] 메시지 템플릿 생성 — 이름은 프로젝트 안에서 유일 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = templateSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const row = (
    await getDb()
      .insert(messageTemplates)
      .values({ projectId: id, name: b.name, title: b.title, body: b.body, deepLink: b.deep_link ?? null, fields: b.fields })
      .onConflictDoNothing({ target: [messageTemplates.projectId, messageTemplates.name] })
      .returning()
  )[0];
  if (!row) return fail("A template with this name already exists", 409);
  return ok({ template: row }, undefined, 201);
}

