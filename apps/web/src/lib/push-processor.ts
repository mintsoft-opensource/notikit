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

/** 억제 리스트(token + external_id 유저의 디바이스) 제외 */
async function filterSuppressed(db: ReturnType<typeof getDb>, projectId: string, tokens: string[]): Promise<string[]> {
  if (tokens.length === 0) return tokens;
  const sup = await db.select().from(suppressions).where(eq(suppressions.projectId, projectId));
  const blockedTokens = new Set(sup.map((s) => s.token).filter(Boolean) as string[]);
  const blockedExtIds = sup.map((s) => s.externalId).filter(Boolean) as string[];

  const blockedByUser = new Set<string>();
  if (blockedExtIds.length) {
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
      .where(and(eq(devices.projectId, projectId), inArray(pushUsers.externalId, blockedExtIds)));
    for (const r of rows) blockedByUser.add(r.token);
  }
  return tokens.filter((t) => !blockedTokens.has(t) && !blockedByUser.has(t));
}

async function reload(db: ReturnType<typeof getDb>, logId: string): Promise<PushLog | undefined> {
  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/**
 * 큐잉된 푸시 로그 1건 처리. **원자적 클레임**으로 중복 발송 방지.
 * - Firebase 크레덴셜 없음 → **log-only**(status="logged": 실제 발송 없이 대상만 기록)
 * - 있으면 실제 FCM 배치 발송 + 무효토큰 비활성화.
 */
export async function processPushLog(logId: string): Promise<PushLog | undefined> {
  const db = getDb();

  // 원자적 클레임: queued → processing (경쟁 워커 중복 방지)
  const claimed = await db
    .update(pushLogs)
    .set({ status: "processing" })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.status, "queued")))
    .returning();
  if (claimed.length === 0) return reload(db, logId); // 이미 다른 워커가 처리
  const log = claimed[0];

  try {
    const project = (await db.select().from(projects).where(eq(projects.id, log.projectId)).limit(1))[0];
    const tokens = await filterSuppressed(db, log.projectId, await resolveTokens(db, log));

    // log-only 모드 — 실발송 없이 대상 수만 기록 (Firebase 미구성/테스트)
    if (!project?.firebaseCredentialsEnc) {
      await db.update(pushLogs).set({ status: "logged", totalCount: tokens.length }).where(eq(pushLogs.id, logId));
      return reload(db, logId);
    }

    const sa = parseServiceAccount(decryptSecret(project.firebaseCredentialsEnc));
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

  return reload(db, logId);
}

/** 프로젝트의 큐잉된 로그를 일괄 처리 (worker/cron 진입점). */
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
