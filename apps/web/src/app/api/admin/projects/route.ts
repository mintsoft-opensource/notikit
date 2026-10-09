import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects, organizations } from "@/db/schema";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";
import { ok, fail } from "@/lib/api-response";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { generateApiKey, generateApiSecret, encryptSecret } from "@/lib/keys";
import { requireAuth, checkOrigin } from "@/lib/authz";
import { z } from "zod";

export const dynamic = "force-dynamic";

type ProjectRow = typeof projects.$inferSelect;

/** 응답용 공개 필드 화이트리스트 — 암호문(secret/firebase)은 노출 금지, 설정 여부만 boolean */
function publicProject(p: ProjectRow) {
  return {
    id: p.id,
    orgId: p.orgId,
    name: p.name,
    environment: p.environment,
    apiKey: p.apiKey,
    requireIdentityVerification: p.requireIdentityVerification,
    quietStartHour: p.quietStartHour,
    quietEndHour: p.quietEndHour,
    hasFirebase: !!p.firebaseCredentialsEnc,
    createdAt: p.createdAt,
  };
}

const LIMIT = 200;

/**
 * [Web Admin] 프로젝트 목록 — 세션은 자기 org, superadmin(token)은 전체.
 *
 * 커서로 이어 읽는다. 워커가 이 목록으로 처리 대상을 정하므로 한 페이지에서 끊으면
 * 그 뒤의 프로젝트는 큐 처리·저니·웹훅 재시도·토큰 스윕이 **영구히** 돌지 않는다.
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req);
  if (!auth.ok) return fail(auth.error, auth.status);

  const cursor = parseCursor(new URL(req.url));
  const conds = [];
  if (!auth.ctx.superadmin) conds.push(eq(projects.orgId, auth.ctx.orgId!));
  if (cursor) conds.push(beforeCursor(projects.createdAt, projects.id, cursor));

  const db = getDb();
  const rows = await db
    .select({ row: projects, cursorTs: cursorExpr(projects.createdAt) })
    .from(projects)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const page = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({
    projects: page.map((r) => publicProject(r.row)),
    next: nextCursor(
      page.map((r) => ({ cursorTs: r.cursorTs, id: r.row.id })),
      hasMore
    ),
  });
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  org_id: z.string().uuid().optional(),
  environment: z.enum(["dev", "staging", "production"]).default("production"),
});

/** [Web Admin] 프로젝트 생성 — api-key/secret 발급 */
export async function POST(req: Request) {
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const auth = await requireAuth(req, { write: true });
  if (!auth.ok) return fail(auth.error, auth.status);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = createSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  // 세션 로그인은 자기 org 로 강제. superadmin(token)은 org_id 지정 또는 신규 org.
  let orgId = auth.ctx.superadmin ? b.org_id : auth.ctx.orgId!;
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

  // api_secret 은 생성 시 한 번만 반환 (암호화 저장됨)
  return ok({ project: publicProject(row), api_secret: apiSecret }, { note: "api_secret is shown once — store it now" }, 201);
}
