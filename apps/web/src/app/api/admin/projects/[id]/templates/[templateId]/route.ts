import { and, eq, ne } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messageTemplates } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { requireProject, checkOrigin } from "@/lib/authz";
import { templateSchema } from "@/lib/templates";

export const dynamic = "force-dynamic";

function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}

type Ctx = { params: Promise<{ id: string; templateId: string }> };

/** 모든 조회에 projectId 를 함께 건다 — id 추측만으로 다른 프로젝트의 템플릿을 건드리지 못하게 */
const scoped = (projectId: string, templateId: string) =>
  and(eq(messageTemplates.id, templateId), eq(messageTemplates.projectId, projectId));

export async function GET(req: Request, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const row = (await getDb().select().from(messageTemplates).where(scoped(id, templateId)).limit(1))[0];
  if (!row) return fail("Not found", 404);
  return ok({ template: row });
}

/** 전체 교체 — 템플릿은 폼 하나로 편집하므로 부분 수정을 따로 두지 않는다 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
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

  const db = getDb();
  const taken = (
    await db
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(and(eq(messageTemplates.projectId, id), eq(messageTemplates.name, b.name), ne(messageTemplates.id, templateId)))
      .limit(1)
  )[0];
  if (taken) return fail("A template with this name already exists", 409, { code: "template_name_taken" });

  let row;
  try {
    row = (
      await db
        .update(messageTemplates)
        .set({ name: b.name, title: b.title, body: b.body, deepLink: b.deep_link ?? null, fields: b.fields, updatedAt: new Date() })
        .where(scoped(id, templateId))
        .returning()
    )[0];
  } catch (e) {
    // 위 확인과 update 사이에 같은 이름이 생긴 경우 — 유니크 인덱스가 막는다
    if (isUniqueViolation(e)) return fail("A template with this name already exists", 409, { code: "template_name_taken" });
    throw e;
  }
  if (!row) return fail("Not found", 404);
  return ok({ template: row });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { id, templateId } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return fail(authz.error, authz.status);

  const deleted = await getDb().delete(messageTemplates).where(scoped(id, templateId)).returning({ id: messageTemplates.id });
  if (deleted.length === 0) return fail("Not found", 404);
  return ok({ deleted: 1 });
}
