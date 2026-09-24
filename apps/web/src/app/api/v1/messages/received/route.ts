import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushLogs, pushReceipts } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimitShared, clientKey, principalKey } from "@/lib/rate-limit";
import { isPlausibleRecipient } from "@/lib/click-eligibility";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

/** 테넌트 전체 상한 — 대형 발송 직후 전 단말이 동시에 보고해도 담을 수 있어야 한다 */
const PROJECT_LIMIT_PER_MIN = 60_000;
/**
 * 기기 하나가 분당 보고할 수 있는 수신 건수. 정상 SDK 는 발송당 1건이고 재보고는 유니크로
 * 무시되므로, 이 한도에 닿는 것은 남용뿐이고 걸려도 **그 기기만** 걸린다.
 */
const DEVICE_LIMIT_PER_MIN = 60;

const schema = z.object({
  log_id: z.string().uuid(),
  /** 알림을 받은 단말의 푸시 토큰 */
  token: z.string().min(1).max(4096),
});

/**
 * 단말 수신 보고 (public: api-key) — "**FCM 이 받아들였다**"와 "**기기가 실제로 받았다**"를 가른다.
 *
 * 지금까지 성공은 FCM 접수(success_count)뿐이었다. 접수는 기기가 꺼져 있어도, 앱이 지워져 있어도
 * 성공한다 — 그 수를 도달로 읽으면 도달률이 늘 실제보다 높고, 그 위에 올린 A/B·전환 비교도 같이 뜬다.
 *
 * (log, device) 유니크라 SDK 가 재시도·중복 콜백으로 여러 번 보내도 한 번만 센다.
 * 클릭과 같은 자격 검사를 건다 — 아무 토큰이나 등록해 도달 수를 부풀리지 못하게.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!(await rateLimitShared(clientKey(project.id, "receipt"), PROJECT_LIMIT_PER_MIN))) {
    return fail("Rate limit exceeded", 429);
  }

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  // 기기 차원 한도는 조회 전에 — 남용이 pushLogs/devices 조회까지 내려가지 않게
  if (!(await rateLimitShared(principalKey(project.id, "receipt", b.token), DEVICE_LIMIT_PER_MIN))) {
    return fail("Rate limit exceeded", 429);
  }

  const db = getDb();
  // 발송 로그는 반드시 이 프로젝트 것 — 타 테넌트 로그에 도달을 심지 못하게
  const log = (
    await db.select().from(pushLogs).where(and(eq(pushLogs.id, b.log_id), eq(pushLogs.projectId, project.id))).limit(1)
  )[0];
  if (!log) return fail("Message not found", 404);

  const device = (
    await db
      .select({ id: devices.id, userId: devices.userId, platform: devices.platform, createdAt: devices.createdAt })
      .from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
      .limit(1)
  )[0];
  if (!device) return fail("Device not found", 404);
  if (!(await isPlausibleRecipient(db, log, device))) {
    return fail("Device was not a recipient of this message", 403);
  }

  // 삽입과 증분을 한 트랜잭션으로 — 둘이 함께 커밋되므로 "행은 있는데 +1 이 빠진" 상태가 없다.
  // 삽입이 충돌하면(재보고) 카운터는 그대로 — 그래서 매 보고마다 다시 세지 않아도 된다.
  const recorded = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(pushReceipts)
      .values({ projectId: project.id, logId: log.id, deviceId: device.id, platform: device.platform })
      .onConflictDoNothing({ target: [pushReceipts.logId, pushReceipts.deviceId] })
      .returning({ logId: pushReceipts.logId });
    if (inserted.length === 0) return false;
    await tx
      .update(pushLogs)
      .set({ deliveredCount: sql`${pushLogs.deliveredCount} + 1` })
      .where(eq(pushLogs.id, log.id));
    return true;
  });

  return ok({ recorded }, undefined, 202);
}
