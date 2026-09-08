import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { organizations, adminUsers, projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireAuth, checkOrigin } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";

export const dynamic = "force-dynamic";

const patchSchema = z.object({ name: z.string().trim().min(1).max(120) });

/** [Web Admin] 현재 org 정보 — superadmin(x-admin-token)은 org 컨텍스트가 없다 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);
  if (auth.ctx.superadmin) return ok({ org: null });

  const db = getDb();
  const orgId = auth.ctx.orgId!;
  const [org, [{ members }], [{ projectCount }]] = await Promise.all([
    db
      .select({ id: organizations.id, name: organizations.name, createdAt: organizations.createdAt })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .limit(1)
      .then((r) => r[0]),
    db.select({ members: sql<number>`count(*)::int` }).from(adminUsers).where(eq(adminUsers.orgId, orgId)),
    db.select({ projectCount: sql<number>`count(*)::int` }).from(projects).where(eq(projects.orgId, orgId)),
  ]);
  if (!org) return fail("Organization not found", 404);

  return ok({ org: { ...org, members, projects: projectCount } });
}

/** [Web Admin] org 이름 변경 — owner 만 (조직 정체성 변경이므로 admin 에게도 열지 않는다) */
export async function PATCH(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);
  if (!auth.ctx.superadmin && auth.ctx.role !== "owner") return fail("Forbidden: owner 만 변경할 수 있습니다", 403);
  if (auth.ctx.superadmin) return fail("org 컨텍스트가 없습니다", 400);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = patchSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);

  const updated = (
    await getDb()
      .update(organizations)
      .set({ name: parsed.data.name })
      .where(eq(organizations.id, auth.ctx.orgId!))
      .returning({ id: organizations.id, name: organizations.name })
  )[0];
  if (!updated) return fail("Organization not found", 404);

  return ok({ org: updated });
}
