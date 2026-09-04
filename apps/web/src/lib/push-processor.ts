import { randomUUID } from "node:crypto";
import { and, eq, or, lt, lte, gt, isNull, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, topics, subscriptions, suppressions, notifications, segments, type PushLog } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";
import { emitWebhook } from "@/lib/webhooks";

const PAGE = 2000; // DB 조회 페이지 (전체 토큰을 메모리에 한 번에 올리지 않음)
const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 5; // 동시 FCM 호출 수
const STALE_MS = 5 * 60 * 1000; // 'processing' 에 멈춘 로그 재클레임 임계

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** A/B 변형 배정 — 토큰 해시로 결정적 분배 */
function variantIndex(token: string, n: number): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
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

  // 세그먼트: 유저 속성 규칙(AND) 매칭 → 해당 유저의 활성 디바이스 (keyset)
  if (log.type === "segment" && log.target) {
    const seg = (
      await db.select({ rules: segments.rules }).from(segments)
        .where(and(eq(segments.projectId, log.projectId), eq(segments.name, log.target))).limit(1)
    )[0];
    if (!seg) return;
    const conds: SQL[] = [eq(devices.projectId, log.projectId), eq(devices.isActive, true)];
    for (const r of seg.rules) conds.push(sql`${pushUsers.attributes} ->> ${r.attribute} = ${r.value}`);

    let cur = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const rows = await db
        .select({ id: devices.id, token: devices.token }).from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(...conds, gt(devices.id, cur)))
        .orderBy(devices.id).limit(PAGE);
      if (rows.length === 0) break;
      yield rows.map((r) => r.token);
      cur = rows[rows.length - 1].id;
      if (rows.length < PAGE) break;
    }
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

  // keyset 페이지네이션 (devices.id 커서) — 결정적·deep-page 성능 안정
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let rows: { id: string; token: string }[];
    if (topicId) {
      rows = await db
        .select({ id: devices.id, token: devices.token }).from(subscriptions)
        .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
        .where(and(eq(subscriptions.topicId, topicId), eq(devices.projectId, log.projectId), eq(devices.isActive, true), gt(devices.id, cursor)))
        .orderBy(devices.id).limit(PAGE);
    } else {
      rows = await db
        .select({ id: devices.id, token: devices.token }).from(devices)
        .where(and(eq(devices.projectId, log.projectId), eq(devices.isActive, true), gt(devices.id, cursor)))
        .orderBy(devices.id).limit(PAGE);
    }
    if (rows.length === 0) break;
    yield rows.map((r) => r.token);
    cursor = rows[rows.length - 1].id;
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

  const now = new Date();
  const myToken = randomUUID();
  const claimed = await db
    .update(pushLogs)
    .set({ status: "processing", lockedAt: now, lockToken: myToken })
    .where(
      and(
        eq(pushLogs.id, logId),
        or(
          eq(pushLogs.status, "queued"),
          and(eq(pushLogs.status, "scheduled"), lte(pushLogs.scheduledAt, now)),
          and(eq(pushLogs.status, "processing"), or(isNull(pushLogs.lockedAt), lt(pushLogs.lockedAt, staleBefore)))
        )
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

    const variants = log.variants ?? null;
    const variantStats: Record<string, { sent: number; success: number }> = {};
    if (variants) variants.forEach((_, i) => (variantStats[String(i)] = { sent: 0, success: 0 }));
    const invalidAll: string[] = [];

    for await (const page of tokenPages(db, log)) {
      // fencing: 각 페이지 발송 전 소유권(하트비트) 확인 — 잃었으면 즉시 중단(중복 발송 방지)
      const hb = await db
        .update(pushLogs)
        .set({ lockedAt: new Date() })
        .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, myToken)))
        .returning({ id: pushLogs.id });
      if (hb.length === 0) return reload(db, logId);

      const tokens = page.filter((t) => !suppression.has(t));
      total += tokens.length;
      if (tokens.length === 0) continue;

      if (variants) {
        // A/B: 토큰을 변형에 배정 후 각 변형 콘텐츠로 발송
        const groups: string[][] = variants.map(() => []);
        for (const t of tokens) groups[variantIndex(t, variants.length)].push(t);
        for (let vi = 0; vi < variants.length; vi++) {
          variantStats[String(vi)].sent += groups[vi].length;
          if (logOnly || groups[vi].length === 0) continue;
          const v = variants[vi];
          const results = await mapLimit(chunk(groups[vi], BATCH), CONCURRENCY, (b) =>
            sendToTokens(project!.id, sa!, b, { title: v.title, body: v.body, deepLink: log.deepLink ?? undefined, data: log.data ?? undefined })
          );
          for (const r of results) {
            success += r.success;
            failure += r.failure;
            variantStats[String(vi)].success += r.success;
            invalidAll.push(...r.invalidTokens);
          }
        }
      } else if (!logOnly) {
        const results = await mapLimit(chunk(tokens, BATCH), CONCURRENCY, (b) =>
          sendToTokens(project!.id, sa!, b, { title: log.title, body: log.body, deepLink: log.deepLink ?? undefined, data: log.data ?? undefined })
        );
        for (const r of results) {
          success += r.success;
          failure += r.failure;
          invalidAll.push(...r.invalidTokens);
        }
      }
    }
    // 무효 토큰 일괄 비활성화 (완료 후 · 1000개씩 청크로 과대 IN 쿼리 방지)
    for (const c of chunk(invalidAll, 1000)) {
      await db.update(devices).set({ isActive: false })
        .where(and(eq(devices.projectId, project!.id), inArray(devices.token, c)));
    }

    // fencing: 우리가 여전히 이 로그의 소유자일 때만 완료 처리(부작용 1회 보장)
    const finalStatus = logOnly ? "logged" : "completed";
    const finalized = await db
      .update(pushLogs)
      .set({ status: finalStatus, totalCount: total, successCount: success, failureCount: failure, ...(variants ? { variantStats } : {}) })
      .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, myToken)))
      .returning({ id: pushLogs.id });
    if (finalized.length === 0) return reload(db, logId); // stale 재클레임에 의해 대체됨 → 부작용 스킵

    // In-app 인박스: 단건(유저 타겟) 발송은 알림 이력 저장 (소유 확인 후 1회)
    if (log.type === "single" && log.target) {
      const u = (
        await db.select({ id: pushUsers.id }).from(pushUsers)
          .where(and(eq(pushUsers.projectId, log.projectId), eq(pushUsers.externalId, log.target))).limit(1)
      )[0];
      if (u) {
        await db.insert(notifications).values({
          projectId: log.projectId,
          userId: u.id,
          title: log.title,
          body: log.body,
          deepLink: log.deepLink,
          data: log.data,
        });
      }
    }

    // 웹훅 발행 (논블로킹, 소유 확인 후 1회)
    void emitWebhook(log.projectId, "message.sent", {
      message_id: logId,
      status: finalStatus,
      total,
      success,
      failure,
    }).catch(() => {});
  } catch (e) {
    // 우리 소유일 때만 실패 표시 (새 워커의 클레임을 덮지 않음)
    await db.update(pushLogs).set({ status: "failed" }).where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, myToken)));
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
        or(
          eq(pushLogs.status, "queued"),
          and(eq(pushLogs.status, "scheduled"), lte(pushLogs.scheduledAt, new Date())),
          and(eq(pushLogs.status, "processing"), lt(pushLogs.lockedAt, staleBefore))
        )
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
