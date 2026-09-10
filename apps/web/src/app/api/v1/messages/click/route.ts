import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushClicks, pushLogs } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { isPlausibleRecipient } from "@/lib/click-eligibility";
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
    await db.select({ id: devices.id, userId: devices.userId, platform: devices.platform }).from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token))).limit(1)
  )[0];
  if (!device) return fail("Device not found", 404);

  // 이 디바이스가 애초에 이 발송의 대상이었는지 — 아무 토큰이나 등록해 클릭을 찍는 것을 막는다
  if (!(await isPlausibleRecipient(db, log, device.id, device.userId))) {
    return fail("Device was not a recipient of this message", 403);
  }

  // 삽입과 집계를 한 트랜잭션으로. 따로 커밋하면 (a) 사이에서 죽었을 때 클릭은 남고
  // 카운터만 영영 누락되고, (b) 동시 클릭이 read-committed 스냅샷으로 서로의 최신값을
  // 덮어쓴다. 로그 행을 먼저 잠가 집계를 직렬화한다.
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
      })
      .onConflictDoNothing({ target: [pushClicks.logId, pushClicks.deviceId] })
      .returning({ id: pushClicks.id });
    // 행 잠금 획득 후에 집계 — 이 시점 이후의 서브쿼리는 앞선 트랜잭션의 커밋을 본다
    await tx.execute(sql`select 1 from ${pushLogs} where ${pushLogs.id} = ${log.id} for update`);
    // 증분(+1)이 아니라 **절대값 재계산**이다. 증분은 삽입 성공 후 갱신 전에 죽으면
    // 영구히 어긋난다(재시도는 유니크 충돌로 갱신을 건너뛴다). 절대값이면 재시도가
    // 스스로 복구하므로 삽입이 없었어도 다시 센다.
    await tx
      .update(pushLogs)
      .set({
        clickCount: sql`(
          select count(*)::int from ${pushClicks} where ${pushClicks.logId} = ${log.id}
        )`,
        clickUserCount: sql`(
          select count(distinct ${pushClicks.userId})::int from ${pushClicks}
          where ${pushClicks.logId} = ${log.id} and ${pushClicks.userId} is not null
        )`,
      })
      .where(eq(pushLogs.id, log.id));
    return inserted.length > 0;
  });

  return ok({ recorded }, undefined, 202);
}
