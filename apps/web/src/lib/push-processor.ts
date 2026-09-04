import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, topics, subscriptions, suppressions, type PushLog } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";

const BATCH = 500;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 발송 대상 활성 토큰 해석 (type: single=유저, broadcast=전체, topic=구독자) */
async function resolveTokens(db: ReturnType<typeof getDb>, log: PushLog): Promise<string[]> {
  if (log.type === "broadcast") {
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .where(and(eq(devices.projectId, log.projectId), eq(devices.isActive, true)));
    return rows.map((r) => r.token);
  }

  if (log.type === "topic" && log.target) {
    const topic = (
      await db.select().from(topics).where(and(eq(topics.projectId, log.projectId), eq(topics.name, log.target))).limit(1)
    )[0];
    if (!topic) return [];
    const rows = await db
      .select({ token: devices.token })
      .from(subscriptions)
      .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
      .where(and(eq(subscriptions.topicId, topic.id), eq(devices.isActive, true)));
    return rows.map((r) => r.token);
  }

  // single: target = 유저 external_id
  if (log.target) {
    const user = (
      await db.select().from(pushUsers).where(and(eq(pushUsers.projectId, log.projectId), eq(pushUsers.externalId, log.target))).limit(1)
    )[0];
    if (!user) return [];
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .where(and(eq(devices.projectId, log.projectId), eq(devices.userId, user.id), eq(devices.isActive, true)));
    return rows.map((r) => r.token);
  }
  return [];
}

/** 억제 리스트(token/externalId) 제외 */
async function filterSuppressed(db: ReturnType<typeof getDb>, projectId: string, tokens: string[]): Promise<string[]> {
  if (tokens.length === 0) return tokens;
  const sup = await db.select({ token: suppressions.token }).from(suppressions).where(eq(suppressions.projectId, projectId));
  const blocked = new Set(sup.map((s) => s.token).filter(Boolean) as string[]);
  return tokens.filter((t) => !blocked.has(t));
}

/**
 * 큐잉된 푸시 로그 1건을 실제 발송 처리.
 * 크레덴셜 복호화 → 토큰 해석 → 억제 필터 → FCM 배치 발송 → 카운트 갱신 + 무효토큰 비활성화.
 */
export async function processPushLog(logId: string): Promise<PushLog | undefined> {
  const db = getDb();
  const log = (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
  if (!log || log.status !== "queued") return log;

  const project = (await db.select().from(projects).where(eq(projects.id, log.projectId)).limit(1))[0];
  await db.update(pushLogs).set({ status: "processing" }).where(eq(pushLogs.id, logId));

  try {
    if (!project?.firebaseCredentialsEnc) throw new Error("Firebase credentials not configured for project");
    const sa = parseServiceAccount(decryptSecret(project.firebaseCredentialsEnc));

    const tokens = await filterSuppressed(db, project.id, await resolveTokens(db, log));

    let success = 0;
    let failure = 0;
    const invalid: string[] = [];
    for (const batch of chunk(tokens, BATCH)) {
      const r = await sendToTokens(project.id, sa, batch, {
        title: log.title,
        body: log.body,
        deepLink: log.deepLink ?? undefined,
        data: log.data ?? undefined,
      });
      success += r.success;
      failure += r.failure;
      invalid.push(...r.invalidTokens);
    }

    if (invalid.length) {
      await db
        .update(devices)
        .set({ isActive: false })
        .where(and(eq(devices.projectId, project.id), inArray(devices.token, invalid)));
    }

    await db
      .update(pushLogs)
      .set({ status: "completed", totalCount: tokens.length, successCount: success, failureCount: failure })
      .where(eq(pushLogs.id, logId));
  } catch (e) {
    await db.update(pushLogs).set({ status: "failed" }).where(eq(pushLogs.id, logId));
    throw e;
  }

  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/** 프로젝트의 큐잉된 로그를 일괄 처리 (worker/cron 진입점). 처리 건수 반환. */
export async function drainQueue(projectId: string, limit = 50): Promise<{ processed: number; failed: number }> {
  const db = getDb();
  const queued = await db
    .select({ id: pushLogs.id })
    .from(pushLogs)
    .where(and(eq(pushLogs.projectId, projectId), eq(pushLogs.status, "queued")))
    .limit(limit);

  let processed = 0;
  let failed = 0;
  for (const { id } of queued) {
    try {
      await processPushLog(id);
      processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { processed, failed };
}
