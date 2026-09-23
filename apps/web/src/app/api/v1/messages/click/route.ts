import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushClicks, pushLogs } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { isPlausibleRecipient } from "@/lib/click-eligibility";
import { variantForToken } from "@/lib/push-variant";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  log_id: z.string().uuid(),
  /** 알림을 받은 디바이스의 푸시 토큰. 유저는 이 토큰의 바인딩에서 서버가 해석한다. */
  token: z.string().min(1).max(4096),
  /** 실제 착지한 화면/URL. 발송의 deep_link 와 다를 수 있다(폴백·리다이렉트). */
  destination: z.string().max(2048).optional(),
});

/**
 * 푸시 클릭(알림 탭) 보고 (public: api-key).
 *
 * 유저 귀속은 클라이언트가 보낸 external_id 가 아니라 **서버가 devices.userId 에서 해석**한다.
 * 클라이언트 주장을 믿으면 등록 시 identity_hash 로 막아둔 사칭이 클릭 경로로 다시 열리고,
 * 오염된 클릭 통계는 그대로 AI 학습 신호가 된다.
 *
 * 재클릭은 (log_id, device) 유니크로 무시 — 클릭률이 부풀지 않게.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "click"), 20_000)) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  // 발송 로그는 반드시 이 프로젝트 것 — 타 테넌트 로그에 클릭을 심지 못하게
  const log = (
    await db.select().from(pushLogs)
      .where(and(eq(pushLogs.id, b.log_id), eq(pushLogs.projectId, project.id))).limit(1)
  )[0];
  if (!log) return fail("Message not found", 404);

  const device = (
    await db.select({ id: devices.id, userId: devices.userId, platform: devices.platform, createdAt: devices.createdAt }).from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token))).limit(1)
  )[0];
  if (!device) return fail("Device not found", 404);

  // 이 디바이스가 애초에 이 발송의 대상이었는지 — 아무 토큰이나 등록해 클릭을 찍는 것을 막는다
  if (!(await isPlausibleRecipient(db, log, device))) {
    return fail("Device was not a recipient of this message", 403);
  }

  // 삽입과 증분을 한 트랜잭션으로 — 둘이 함께 커밋되므로 "삽입은 됐는데 +1 이 빠진" 상태가 없다.
  // 그래서 매 클릭마다 push_clicks 를 전부 다시 세던 절대값 재계산이 필요 없다(대형 발송에서 O(클릭 수)).
  const recorded = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pushClicks)
      .values({
        projectId: project.id,
        logId: log.id,
        deviceId: device.id,
        userId: device.userId,
        platform: device.platform,
        destination: b.destination,
        // 변형별 클릭률을 내려면 이 기기가 어느 변형을 받았는지 남겨야 한다.
        // 배정은 발송기와 같은 해시 규칙(push-variant)이라 재계산해도 같은 값이 나온다.
        variant: variantForToken(b.token, log.variants?.length),
      })
      .onConflictDoNothing({ target: [pushClicks.logId, pushClicks.deviceId] })
      .returning({ id: pushClicks.id });
    if (inserted.length === 0) return false; // 재클릭 — 카운터 그대로

    // 로그 행을 잠가 같은 사람의 다른 기기 클릭과 직렬화한다. 잠금 뒤의 조회는 앞선 트랜잭션의
    // 커밋을 보므로 "이 사람의 첫 클릭인가"를 정확히 판정한다.
    await tx.execute(sql`select 1 from ${pushLogs} where ${pushLogs.id} = ${log.id} for update`);
    let firstForUser = false;
    if (device.userId) {
      const same = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(pushClicks)
        .where(and(eq(pushClicks.logId, log.id), eq(pushClicks.userId, device.userId)));
      firstForUser = Number(same[0]?.n ?? 0) === 1;
    }
    await tx
      .update(pushLogs)
      .set({
        clickCount: sql`${pushLogs.clickCount} + 1`,
        ...(firstForUser ? { clickUserCount: sql`${pushLogs.clickUserCount} + 1` } : {}),
      })
      .where(eq(pushLogs.id, log.id));
    return true;
  });

  return ok({ recorded }, undefined, 202);
}
