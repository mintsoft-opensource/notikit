import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { devices, pushUsers, segments, subscriptions, topics, type PushLog } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * 이 디바이스가 이 발송의 수신 대상이었을 수 있는가.
 *
 * 클릭 보고는 공개 api-key 로 들어오고, 디바이스 등록도 공개 api-key 만으로 되므로
 * 검사가 없으면 아무 토큰이나 등록해 같은 발송에 클릭을 무한히 만들어낼 수 있다
 * (유니크는 디바이스당 1회만 막을 뿐 디바이스 수를 막지 못한다).
 *
 * 발송 시점의 수신자 명단을 따로 남기지 않으므로 **자격 검사**로 근사한다.
 * broadcast 는 프로젝트의 모든 디바이스가 대상이라 좁힐 여지가 없다 — 그 경우
 * 남는 방어선은 레이트리밋과 (log_id, device) 유니크뿐이다.
 */
export async function isPlausibleRecipient(db: Db, log: PushLog, deviceId: string, userId: string | null): Promise<boolean> {
  if (log.type === "broadcast") return true;
  if (!log.target) return false;

  if (log.type === "single") {
    if (!userId) return false;
    const u = (
      await db
        .select({ id: pushUsers.id })
        .from(pushUsers)
        .where(and(eq(pushUsers.projectId, log.projectId), eq(pushUsers.externalId, log.target)))
        .limit(1)
    )[0];
    return u?.id === userId;
  }

  if (log.type === "topic") {
    const row = (
      await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .innerJoin(topics, eq(subscriptions.topicId, topics.id))
        .where(
          and(
            eq(topics.projectId, log.projectId),
            eq(topics.name, log.target),
            eq(subscriptions.deviceId, deviceId)
          )
        )
        .limit(1)
    )[0];
    return Boolean(row);
  }

  if (log.type === "segment") {
    if (!userId) return false;
    const seg = (
      await db
        .select({ rules: segments.rules })
        .from(segments)
        .where(and(eq(segments.projectId, log.projectId), eq(segments.name, log.target)))
        .limit(1)
    )[0];
    if (!seg) return false;
    const conds = [eq(devices.id, deviceId), eq(devices.projectId, log.projectId)];
    for (const r of seg.rules) conds.push(sql`${pushUsers.attributes} ->> ${r.attribute} = ${r.value}`);
    const row = (
      await db
        .select({ id: devices.id })
        .from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(...conds))
        .limit(1)
    )[0];
    return Boolean(row);
  }

  return false;
}
