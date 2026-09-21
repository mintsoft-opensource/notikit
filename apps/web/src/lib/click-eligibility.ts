import { and, eq, sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { devices, pushUsers, subscriptions, topics, type PushLog } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

export interface ClickDevice {
  id: string;
  userId: string | null;
  /** 발송 시점에 이 기기가 존재했는지 판단하는 기준 */
  createdAt: Date;
}

/**
 * 이 디바이스가 이 발송의 수신 대상이었을 수 있는가.
 *
 * 클릭 보고는 공개 api-key 로 들어오고, 디바이스 등록도 공개 api-key 만으로 되므로
 * 검사가 없으면 아무 토큰이나 등록해 같은 발송에 클릭을 무한히 만들어낼 수 있다
 * (유니크는 디바이스당 1회만 막을 뿐 디바이스 수를 막지 못한다).
 *
 * 발송 시점의 수신자 명단을 따로 남기지 않으므로 **자격 검사**로 근사한다.
 *
 * 모든 타입에 공통으로 거는 조건: **발송보다 나중에 생긴 기기는 그 발송을 받을 수 없다.**
 * 이 한 줄이 "지금 가짜 토큰을 등록해 과거 발송을 클릭"하는 경로를 전부 닫는다.
 * 남는 것은 앞으로 나갈 발송을 기다렸다가 클릭하는 경우뿐이고, 그건 레이트리밋과
 * (log_id, device) 유니크가 받는다.
 */
export async function isPlausibleRecipient(db: Db, log: PushLog, device: ClickDevice): Promise<boolean> {
  // 발송 이후에 등록된 기기는 대상이 될 수 없다.
  //
  // 기준은 큐잉 시각이 아니라 **실제로 나간 시각**이다. 예약 발송은 수신자를 처리
  // 시점에 고르므로, 큐잉 뒤에 등록된 기기도 정당한 수신자가 된다. 큐잉 시각으로
  // 자르면 그 기기들의 클릭이 전부 403 이 되어 예약 발송의 클릭률이 과소 집계된다.
  const sentAt = Math.max(
    new Date(log.createdAt).getTime(),
    log.scheduledAt ? new Date(log.scheduledAt).getTime() : 0
  );
  if (device.createdAt.getTime() > sentAt) return false;

  const { id: deviceId, userId } = device;
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

  // 'segment' 는 통합 이전 로그 — 같은 이름의 토픽으로 흡수됐으므로 같은 경로를 탄다.
  if (log.type === "topic" || log.type === "segment") {
    const topic = (
      await db
        .select({ id: topics.id, rules: topics.rules })
        .from(topics)
        .where(and(eq(topics.projectId, log.projectId), eq(topics.name, log.target)))
        .limit(1)
    )[0];
    if (!topic) return false;

    // 규칙식 그룹: 명단이 없으므로 이 기기의 유저가 지금도 규칙에 맞는지로 근사한다.
    if (topic.rules && topic.rules.length > 0) {
      if (!userId) return false;
      const conds = [eq(devices.id, deviceId), eq(devices.projectId, log.projectId)];
      for (const r of topic.rules) conds.push(sql`${pushUsers.attributes} ->> ${r.attribute} = ${r.value}`);
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

    const row = (
      await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.topicId, topic.id), eq(subscriptions.deviceId, deviceId)))
        .limit(1)
    )[0];
    return Boolean(row);
  }

  return false;
}
