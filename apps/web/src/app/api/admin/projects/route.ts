import { desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, organizations } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { generateApiKey, generateApiSecret, encryptSecret, requireAdmin } from "@/lib/keys";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** api-secret 암호문은 응답에서 제거 */
function publicProject<T extends { apiSecretEnc?: string }>(p: T): Omit<T, "apiSecretEnc"> {
  const { apiSecretEnc: _omit, ...rest } = p;
  return rest;
}

/** [Web Admin] 프로젝트 목록 */
export async function GET(req: Request) {
  if (!requireAdmin(req)) return fail("Unauthorized", 401);
  const db = getDb();
  const rows = await db.select().from(projects).orderBy(desc(projects.createdAt)).limit(200);
  return ok({ projects: rows.map(publicProject) });
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

  const apiSecret = generateApiSecret();
  const row = (
    await db
      .insert(projects)
      .values({
        orgId,
        name: b.name,
        environment: b.environment,
        apiKey: generateApiKey(),
        apiSecretEnc: encryptSecret(apiSecret),
      })
      .returning()
  )[0];

  // api_secret 은 생성 시 한 번만 반환 (해시만 저장됨)
  return ok({ project: publicProject(row), api_secret: apiSecret }, { note: "api_secret is shown once — store it now" }, 201);
}
