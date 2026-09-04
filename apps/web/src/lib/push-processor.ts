import { and, eq, or, lt, isNull, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, topics, subscriptions, suppressions, type PushLog } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";

const PAGE = 2000; // DB 조회 페이지 (전체 토큰을 메모리에 한 번에 올리지 않음)
const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 5; // 동시 FCM 호출 수
const STALE_MS = 5 * 60 * 1000; // 'processing' 에 멈춘 로그 재클레임 임계

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 동시성 제한 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

type Db = ReturnType<typeof getDb>;

/** 억제 토큰 집합 (token 직접 + external_id 유저의 디바이스 토큰) */
async function loadSuppression(db: Db, projectId: string): Promise<Set<string>> {
  const sup = await db.select().from(suppressions).where(eq(suppressions.projectId, projectId));
  const blocked = new Set(sup.map((s) => s.token).filter(Boolean) as string[]);
  const extIds = sup.map((s) => s.externalId).filter(Boolean) as string[];
  if (extIds.length) {
    const rows = await db
      .select({ token: devices.token })
      .from(devices)
      .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
      .where(and(eq(devices.projectId, projectId), inArray(pushUsers.externalId, extIds)));
    for (const r of rows) blocked.add(r.token);
  }
  return blocked;
}

/** 대상 토큰을 페이지 단위로 스트리밍 (broadcast/topic 대량 대응) */
async function* tokenPages(db: Db, log: PushLog): AsyncGenerator<string[]> {
  if (log.type === "single" && log.target) {
    const user = (
      await db.select({ id: pushUsers.id }).from(pushUsers)
        .where(and(eq(pushUsers.projectId, log.projectId), eq(pushUsers.externalId, log.target))).limit(1)
    )[0];
    if (!user) return;
    const rows = await db
      .select({ token: devices.token }).from(devices)
      .where(and(eq(devices.projectId, log.projectId), eq(devices.userId, user.id), eq(devices.isActive, true)));
    if (rows.length) yield rows.map((r) => r.token);
    return;
  }

  let topicId: string | null = null;
  if (log.type === "topic") {
    if (!log.target) return;
    const t = (
      await db.select({ id: topics.id }).from(topics)
        .where(and(eq(topics.projectId, log.projectId), eq(topics.name, log.target))).limit(1)
    )[0];
    if (!t) return;
    topicId = t.id;
  }

  for (let offset = 0; ; offset += PAGE) {
    let rows: { token: string }[];
    if (topicId) {
      rows = await db
        .select({ token: devices.token }).from(subscriptions)
        .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
        .where(and(eq(subscriptions.topicId, topicId), eq(devices.isActive, true)))
        .limit(PAGE).offset(offset);
    } else {
      rows = await db
        .select({ token: devices.token }).from(devices)
        .where(and(eq(devices.projectId, log.projectId), eq(devices.isActive, true)))
        .limit(PAGE).offset(offset);
    }
    if (rows.length === 0) break;
    yield rows.map((r) => r.token);
    if (rows.length < PAGE) break;
  }
}

async function reload(db: Db, logId: string): Promise<PushLog | undefined> {
  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/**
 * 큐잉 로그 1건 처리. 원자적 클레임(+stale 'processing' 재클레임)으로 중복/유실 방지.
 * 대상은 페이지 스트리밍, FCM 배치는 동시성 제한 병렬. 크레덴셜 없으면 log-only.
 */
export async function processPushLog(logId: string): Promise<PushLog | undefined> {
  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_MS);

  const claimed = await db
    .update(pushLogs)
    .set({ status: "processing", lockedAt: new Date() })
    .where(
      and(
        eq(pushLogs.id, logId),
        or(eq(pushLogs.status, "queued"), and(eq(pushLogs.status, "processing"), or(isNull(pushLogs.lockedAt), lt(pushLogs.lockedAt, staleBefore))))
      )
    )
    .returning();
  if (claimed.length === 0) return reload(db, logId); // 다른 워커가 이미 처리
  const log = claimed[0];

  try {
    const project = (await db.select().from(projects).where(eq(projects.id, log.projectId)).limit(1))[0];
    const logOnly = !project?.firebaseCredentialsEnc;
    const sa = logOnly ? null : parseServiceAccount(decryptSecret(project!.firebaseCredentialsEnc!));
    const suppression = await loadSuppression(db, log.projectId);

    let total = 0;
    let success = 0;
    let failure = 0;

    const invalidAll: string[] = [];
    for await (const page of tokenPages(db, log)) {
      const tokens = page.filter((t) => !suppression.has(t));
      total += tokens.length;
      if (logOnly || tokens.length === 0) continue;

      const batches = chunk(tokens, BATCH);
      const results = await mapLimit(batches, CONCURRENCY, (b) =>
        sendToTokens(project!.id, sa!, b, {
          title: log.title,
          body: log.body,
          deepLink: log.deepLink ?? undefined,
          data: log.data ?? undefined,
        })
      );
      for (const r of results) {
        success += r.success;
        failure += r.failure;
        invalidAll.push(...r.invalidTokens);
      }
      // 하트비트: 장시간 발송 중 lock 만료로 재클레임되지 않도록 갱신
      await db.update(pushLogs).set({ lockedAt: new Date() }).where(eq(pushLogs.id, logId));
    }
    // 무효 토큰은 전체 완료 후 일괄 비활성화 (OFFSET 페이지네이션 중 행 이동으로 스킵되는 문제 방지)
    if (invalidAll.length) {
      await db.update(devices).set({ isActive: false })
        .where(and(eq(devices.projectId, project!.id), inArray(devices.token, invalidAll)));
    }

    await db
      .update(pushLogs)
      .set({ status: logOnly ? "logged" : "completed", totalCount: total, successCount: success, failureCount: failure })
      .where(eq(pushLogs.id, logId));
  } catch (e) {
    await db.update(pushLogs).set({ status: "failed" }).where(eq(pushLogs.id, logId));
    throw e;
  }

  return reload(db, logId);
}

/** 큐잉 + stale 로그를 동시성 제한으로 처리 (worker/cron 진입점) */
export async function drainQueue(projectId: string, limit = 50): Promise<{ processed: number; failed: number }> {
  const db = getDb();
  const staleBefore = new Date(Date.now() - STALE_MS);
  const pending = await db
    .select({ id: pushLogs.id })
    .from(pushLogs)
    .where(
      and(
        eq(pushLogs.projectId, projectId),
        or(eq(pushLogs.status, "queued"), and(eq(pushLogs.status, "processing"), lt(pushLogs.lockedAt, staleBefore)))
      )
    )
    .limit(limit);

  let processed = 0;
  let failed = 0;
  const results = await mapLimit(pending, 4, async ({ id }) => {
    try {
      await processPushLog(id);
      return true;
    } catch {
      return false;
    }
  });
  for (const ok of results) ok ? processed++ : failed++;
  return { processed, failed };
}
