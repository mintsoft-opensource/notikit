import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushClicks, pushLogs } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
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
  if (!rateLimit(clientKey(project.id))) return fail("Rate limit exceeded", 429);

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
    await db.select({ id: pushLogs.id }).from(pushLogs)
      .where(and(eq(pushLogs.id, b.log_id), eq(pushLogs.projectId, project.id))).limit(1)
  )[0];
  if (!log) return fail("Message not found", 404);

  const device = (
    await db.select({ id: devices.id, userId: devices.userId, platform: devices.platform }).from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token))).limit(1)
  )[0];
  if (!device) return fail("Device not found", 404);

  const inserted = await db
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

  // 첫 클릭일 때만 집계 캐시 갱신. 유저 단위는 같은 유저의 다른 기기 클릭을 중복으로 세지 않는다.
  if (inserted.length > 0) {
    await db
      .update(pushLogs)
      .set({
        clickCount: sql`${pushLogs.clickCount} + 1`,
        clickUserCount: sql`(
          select count(distinct ${pushClicks.userId})::int from ${pushClicks}
          where ${pushClicks.logId} = ${log.id} and ${pushClicks.userId} is not null
        )`,
      })
      .where(eq(pushLogs.id, log.id));
  }

  return ok({ recorded: inserted.length > 0 }, undefined, 202);
}
