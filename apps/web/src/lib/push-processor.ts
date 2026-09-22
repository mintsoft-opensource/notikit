import { randomUUID } from "node:crypto";
import { and, eq, or, lt, lte, gt, isNull, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, topics, subscriptions, suppressions, notifications, type PushLog } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";
import { emitWebhook, assertSafeWebhookUrl } from "@/lib/webhooks";
import { parseKakaoConfig, sendAlimtalk } from "@/lib/kakao";
import { recordUninstalls, markVerified } from "@/lib/device-events";
import { attrConds, isRuleFilled, type TopicRule } from "@/lib/topic-membership";
import { hasPlaceholders, renderTemplate, type Recipient } from "@/lib/personalize";

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

/**
 * 토픽 해석 — 토픽 하나가 두 방식 중 하나로 명단을 갖는다.
 *
 * `rules` 가 비어 있으면 구독식으로 본다. 규칙 0개를 규칙식으로 받으면
 * "조건 없음 = 전원"이 되어 실수로 전체 발송이 된다. 빈 배열은 API 에서도 막지만,
 * 과거 데이터나 직접 UPDATE 로 들어올 수 있어 여기서도 한 번 더 막는다.
 */
type Group =
  | { kind: "rules"; rules: TopicRule[] }
  | { kind: "subs"; topicId: string };

async function resolveGroup(db: Db, projectId: string, name: string): Promise<Group | null> {
  const t = (
    await db.select({ id: topics.id, rules: topics.rules }).from(topics)
      .where(and(eq(topics.projectId, projectId), eq(topics.name, name))).limit(1)
  )[0];
  if (!t) return null;
  return isRuleFilled(t.rules) ? { kind: "rules", rules: t.rules } : { kind: "subs", topicId: t.id };
}

/** multi 발송의 받는 사람 → 존재하는 유저 id. 없는 아이디는 조용히 빠진다(분모에도 안 잡힌다). */
async function resolveMultiUsers(db: Db, log: PushLog): Promise<string[]> {
  const ids = log.targets ?? [];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: pushUsers.id }).from(pushUsers)
    .where(and(eq(pushUsers.projectId, log.projectId), inArray(pushUsers.externalId, ids)));
  return rows.map((r) => r.id);
}

/** 치환용 — 토큰마다 받는 사람의 아이디·속성. 익명 기기는 null(기본값으로 채워진다). */
async function loadRecipients(db: Db, projectId: string, tokens: string[]): Promise<Map<string, Recipient>> {
  const rows = await db
    .select({ token: devices.token, externalId: pushUsers.externalId, attributes: pushUsers.attributes })
    .from(devices)
    .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
    .where(and(eq(devices.projectId, projectId), inArray(devices.token, tokens)));
  return new Map(
    rows.map((r) => [r.token, r.externalId ? { externalId: r.externalId, attributes: r.attributes } : null])
  );
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

  if (log.type === "multi") {
    const userIds = await resolveMultiUsers(db, log);
    for (const ids of chunk(userIds, PAGE)) {
      const rows = await db
        .select({ token: devices.token }).from(devices)
        .where(and(eq(devices.projectId, log.projectId), inArray(devices.userId, ids), eq(devices.isActive, true)));
      if (rows.length) yield rows.map((r) => r.token);
    }
    return;
  }

  // 토픽: 구독식이면 subscriptions 를, 규칙식이면 유저 속성을 탄다.
  // 'segment' 는 통합 이전에 쌓인 로그 — 같은 이름의 토픽으로 흡수됐으므로 같은 경로로 처리한다.
  let topicId: string | null = null;
  if (log.type === "topic" || log.type === "segment") {
    if (!log.target) return;
    const group = await resolveGroup(db, log.projectId, log.target);
    if (!group) return;

    if (group.kind === "rules") {
      const conds: SQL[] = [
        eq(devices.projectId, log.projectId),
        eq(devices.isActive, true),
        ...attrConds(group.rules),
      ];
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
    topicId = group.topicId;
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
 * 클릭률 분모 — 이 발송이 도달할 수 있었던 **고유 유저 수**와 **디바이스 수**를
 * 발송 시작 전에 확정한다. 구독·디바이스는 계속 변하므로 나중에 세면 과거 발송의 비율이 흔들린다.
 *
 * 두 값을 모두 남기는 이유: 익명 디바이스(userId null)는 유저 분모에 0으로 잡히는데
 * 그 디바이스의 클릭은 clickCount 를 올린다. 짝이 맞는 분모가 없으면 100% 를 넘는 비율이 나온다.
 * → clickUserCount/audienceUserCount, clickCount/audienceDeviceCount 로 짝지어 쓴다.
 *
 * 억제(suppression) 대상은 발송에서 제외되므로 분모에서도 뺀다.
 */
async function countAudience(db: Db, log: PushLog): Promise<{ users: number; devices: number }> {
  const suppressed = await loadSuppression(db, log.projectId);
  const base = [eq(devices.projectId, log.projectId), eq(devices.isActive, true)];

  // 억제 토큰은 목록이 크지 않다고 보고 애플리케이션에서 뺀다(발송 경로와 동일한 기준).
  const tally = (rows: { userId: string | null; token: string }[]) => {
    const users = new Set<string>();
    let deviceCount = 0;
    for (const r of rows) {
      if (suppressed.has(r.token)) continue;
      deviceCount++;
      if (r.userId) users.add(r.userId);
    }
    return { users: users.size, devices: deviceCount };
  };

  if (log.type === "single") {
    if (!log.target) return { users: 0, devices: 0 };
    const u = (
      await db.select({ id: pushUsers.id }).from(pushUsers)
        .where(and(eq(pushUsers.projectId, log.projectId), eq(pushUsers.externalId, log.target))).limit(1)
    )[0];
    // 없는 external_id 로 보내면 수신자가 0인데 분모만 1이 되어 클릭률이 영원히 0% 로 남는다
    if (!u) return { users: 0, devices: 0 };
    const rows = await db
      .select({ userId: devices.userId, token: devices.token }).from(devices)
      .where(and(...base, eq(devices.userId, u.id)));
    return tally(rows);
  }

  if (log.type === "multi") {
    const userIds = await resolveMultiUsers(db, log);
    if (userIds.length === 0) return { users: 0, devices: 0 };
    const rows = await db
      .select({ userId: devices.userId, token: devices.token }).from(devices)
      .where(and(...base, inArray(devices.userId, userIds)));
    return tally(rows);
  }

  if (log.type === "topic" || log.type === "segment") {
    if (!log.target) return { users: 0, devices: 0 };
    const group = await resolveGroup(db, log.projectId, log.target);
    if (!group) return { users: 0, devices: 0 };

    if (group.kind === "rules") {
      const rows = await db
        .select({ userId: devices.userId, token: devices.token })
        .from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(...base, ...attrConds(group.rules)));
      return tally(rows);
    }

    const rows = await db
      .select({ userId: devices.userId, token: devices.token })
      .from(subscriptions)
      .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
      .where(and(eq(subscriptions.topicId, group.topicId), ...base));
    return tally(rows);
  }

  const rows = await db.select({ userId: devices.userId, token: devices.token }).from(devices).where(and(...base));
  return tally(rows);
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

    // 분모는 **발송 시작 전에** 확정한다. 발송 뒤에 세면 그 사이의 구독 해지·바인딩 변경·
    // 무효토큰 비활성화가 반영되어, 실제로 받은 사람보다 작은(때로는 큰) 분모가 남는다.
    const audience = await countAudience(db, log);

    let total = 0;
    let success = 0;
    let failure = 0;

    const variants = log.variants ?? null;
    const personalized = hasPlaceholders(log.title, log.body, ...(variants ?? []).flatMap((v) => [v.title, v.body]));
    const variantStats: Record<string, { sent: number; success: number }> = {};
    if (variants) variants.forEach((_, i) => (variantStats[String(i)] = { sent: 0, success: 0 }));
    const invalidAll: string[] = [];
    // FCM 이 받아준 토큰 — 실재하는 기기로 신뢰할 수 있는 유일한 근거
    const validAll: string[] = [];

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

      // 웹은 data-only 로 보내야 한다(사유는 fcm.ts 의 dataOnly 참조).
      // 페이지 단위 인덱스 조회 한 번 — 제너레이터 4개 분기에 platform 을 끼워넣는
      // 것보다 변경 범위가 좁다.
      const webRows = await db
        .select({ token: devices.token })
        .from(devices)
        .where(and(eq(devices.projectId, log.projectId), eq(devices.platform, "web"), inArray(devices.token, tokens)));
      const webSet = new Set(webRows.map((r) => r.token));
      const splitByPlatform = (list: string[]): Array<{ batch: string[]; dataOnly: boolean }> => {
        const web = list.filter((t) => webSet.has(t));
        const native = list.filter((t) => !webSet.has(t));
        const out: Array<{ batch: string[]; dataOnly: boolean }> = [];
        for (const b of chunk(native, BATCH)) out.push({ batch: b, dataOnly: false });
        for (const b of chunk(web, BATCH)) out.push({ batch: b, dataOnly: true });
        return out;
      };

      // 토큰마다 보낼 내용을 정한다: A/B 변형 배정 → 치환. 같은 내용끼리 묶어 배치로 보낸다.
      // 치환이 없으면 변형 수만큼, 있으면 최악의 경우 사람 수만큼 묶음이 생긴다.
      const recipients = personalized ? await loadRecipients(db, log.projectId, tokens) : null;
      const groups = new Map<string, { vi: number | null; title: string; body: string; tokens: string[] }>();
      for (const tok of tokens) {
        const vi = variants ? variantIndex(tok, variants.length) : null;
        const base = vi === null ? { title: log.title, body: log.body } : variants![vi];
        const who = recipients?.get(tok) ?? null;
        const title = recipients ? renderTemplate(base.title, who) : base.title;
        const body = recipients ? renderTemplate(base.body, who) : base.body;
        const key = `${vi}\u0000${title}\u0000${body}`;
        const g = groups.get(key) ?? { vi, title, body, tokens: [] };
        g.tokens.push(tok);
        groups.set(key, g);
      }

      for (const g of groups.values()) if (g.vi !== null) variantStats[String(g.vi)].sent += g.tokens.length;
      if (logOnly) continue;

      const jobs = [...groups.values()].flatMap((g) => splitByPlatform(g.tokens).map((p) => ({ ...p, g })));
      const results = await mapLimit(jobs, CONCURRENCY, (j) =>
        sendToTokens(project!.id, sa!, j.batch, { title: j.g.title, body: j.g.body, deepLink: log.deepLink ?? undefined, logId: log.id, data: log.data ?? undefined }, false, j.dataOnly)
          .then((r) => ({ r, vi: j.g.vi }))
      );
      for (const { r, vi } of results) {
        success += r.success;
        failure += r.failure;
        if (vi !== null) variantStats[String(vi)].success += r.success;
        invalidAll.push(...r.invalidTokens);
        validAll.push(...r.validTokens);
      }
    }
    // 무효 토큰 비활성화 + **앱 삭제로 기록**. FCM 의 not-registered 판정이
    // 사실상 유일한 삭제 신호라, 여기서 버리면 삭제 추이를 볼 방법이 없다.
    await recordUninstalls(db, project!.id, invalidAll, "send");
    await markVerified(db, project!.id, validAll);

    // fencing: 우리가 여전히 이 로그의 소유자일 때만 완료 처리(부작용 1회 보장)
    const finalStatus = logOnly ? "logged" : "completed";
    const finalized = await db
      .update(pushLogs)
      .set({ status: finalStatus, totalCount: total, successCount: success, failureCount: failure, audienceUserCount: audience.users, audienceDeviceCount: audience.devices, ...(variants ? { variantStats } : {}) })
      .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, myToken)))
      .returning({ id: pushLogs.id });
    if (finalized.length === 0) return reload(db, logId); // stale 재클레임에 의해 대체됨 → 부작용 스킵

    // In-app 인박스: 사람을 지정한 발송(single·multi)만 (소유 확인 후 1회)
    if (log.type === "single" || log.type === "multi") {
      const ids = log.type === "single" ? (log.target ? [log.target] : []) : (log.targets ?? []);
      const users = ids.length
        ? await db
            .select({ id: pushUsers.id, externalId: pushUsers.externalId, attributes: pushUsers.attributes, phone: pushUsers.phone })
            .from(pushUsers)
            .where(and(eq(pushUsers.projectId, log.projectId), inArray(pushUsers.externalId, ids)))
        : [];
      if (users.length) {
        await db.insert(notifications).values(
          users.map((u) => ({
            projectId: log.projectId,
            userId: u.id,
            title: renderTemplate(log.title, u),
            body: renderTemplate(log.body, u),
            deepLink: log.deepLink,
            data: log.data,
          }))
        );
      }

      // 카카오 알림톡 폴백: 단건만. device 발송 성공 0 + phone + 설정 존재 시
      const u = log.type === "single" ? users[0] : undefined;
      if (u && log.kakaoFallback && u.phone && project?.kakaoConfigEnc && success === 0) {
        try {
          const cfg = parseKakaoConfig(decryptSecret(project.kakaoConfigEnc));
          await assertSafeWebhookUrl(cfg.provider_url); // 발송 시점 SSRF 재검증(DNS 변경 대응)
          const r = await sendAlimtalk(cfg, u.phone, `${renderTemplate(log.title, u)}\n${renderTemplate(log.body, u)}`);
          if (r.ok) await db.update(pushLogs).set({ kakaoCount: 1 }).where(eq(pushLogs.id, logId));
        } catch {
          /* 폴백 실패는 무시 */
        }
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
