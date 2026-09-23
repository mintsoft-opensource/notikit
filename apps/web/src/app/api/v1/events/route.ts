import { and, desc, eq, gt, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushClicks, pushConversions, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { verifyIdentity } from "@/lib/keys";
import { attributionCutoff, conversionEventSchema } from "@/lib/conversions";
import { ok, fail } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/**
 * 전환 이벤트 보고 (public: api-key).
 *
 * 앱에서 일어난 행동(구매·가입 등)을 **그 기기/사람이 최근 24시간 안에 클릭한 마지막 발송**에 붙인다.
 * 클릭이 없으면 귀속할 발송이 없으므로 저장하지 않고 202 로 끝낸다 — 푸시와 무관한 행동까지
 * 성과로 세면 전환 지표가 의미를 잃는다.
 *
 * 같은 (발송, 사람, 이름)은 하루 1건만 남는다(유니크). 앱이 재시도해도 매출이 부풀지 않는다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "events"), 20_000)) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = conversionEventSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  // 대상 해석 — 토큰이면 그 기기의 클릭, user_id 면 그 사람의 모든 기기 클릭이 후보다
  let scope: SQL | undefined;
  if (b.token) {
    const device = (
      await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
        .limit(1)
    )[0];
    if (!device) return fail("Device not found", 404);
    scope = eq(pushClicks.deviceId, device.id);
  } else {
    const userId = b.external_id as string;
    // user_id 는 공개 api-key 만으로 지목할 수 있으므로 항상 검증한다(남의 전환 심기 방지)
    if (!b.identity_hash || !verifyIdentity(userId, b.identity_hash, project.apiSecretEnc)) {
      return fail("identity_hash invalid or missing", 403);
    }
    const user = (
      await db
        .select({ id: pushUsers.id })
        .from(pushUsers)
        .where(and(eq(pushUsers.projectId, project.id), eq(pushUsers.externalId, userId)))
        .limit(1)
    )[0];
    if (!user) return fail("User not found", 404);
    scope = eq(pushClicks.userId, user.id);
  }

  const click = (
    await db
      .select({ logId: pushClicks.logId, userId: pushClicks.userId })
      .from(pushClicks)
      .where(and(eq(pushClicks.projectId, project.id), scope, gt(pushClicks.clickedAt, attributionCutoff())))
      .orderBy(desc(pushClicks.clickedAt))
      .limit(1)
  )[0];
  if (!click) return ok({ recorded: false, attributed: false }, undefined, 202);

  const inserted = await db
    .insert(pushConversions)
    .values({
      projectId: project.id,
      logId: click.logId,
      userId: click.userId,
      name: b.name,
      valueCents: b.value_cents ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: pushConversions.id });

  return ok({ recorded: inserted.length > 0, attributed: true, message_id: click.logId }, undefined, 202);
}
