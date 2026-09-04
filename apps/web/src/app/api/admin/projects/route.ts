import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, organizations } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { generateApiKey, generateApiSecret, requireAdmin } from "@/lib/keys";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** [Web Admin] 프로젝트 목록 */
export async function GET(req: Request) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const db = getDb();
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(200);
  return ok({ projects: rows });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  org_id: z.string().uuid().optional(),
  environment: z.enum(["dev", "staging", "production"]).default("production"),
});

/** [Web Admin] 프로젝트 생성 — api-key/secret 발급 */
export async function POST(req: Request) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);

  const parsed = createSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  let orgId = b.org_id;
  if (!orgId) {
    const org = (await db.insert(organizations).values({ name: b.name }).returning())[0];
    orgId = org.id;
  }

  const row = (
    await db
      .insert(projects)
      .values({
        orgId,
        name: b.name,
        environment: b.environment,
        apiKey: generateApiKey(),
        apiSecret: generateApiSecret(),
      })
      .returning()
  )[0];

  return ok({ project: row }, undefined, 201);
}
