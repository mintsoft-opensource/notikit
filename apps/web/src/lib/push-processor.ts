import { randomUUID } from "node:crypto";
import { and, eq, or, lt, lte, gt, ne, isNull, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, pushUserSends, notifications, type PushLog, type Project } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount, type ServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens, sendEachToTokens, SEND_EACH_LIMIT, type FcmMessage, type FcmResult } from "@/lib/fcm";
import { emitWebhook, assertSafeWebhookUrl } from "@/lib/webhooks";
import { parseKakaoConfig, sendAlimtalk } from "@/lib/kakao";
import { recordUninstalls, markVerified } from "@/lib/device-events";
import { countAudience, resolveScope, scopedDevicePage, userNotSuppressed, type Db, type ScopedDevice } from "@/lib/audience-count";
import { hasPlaceholders, renderTemplate, type Recipient, type RenderContext } from "@/lib/personalize";
import { variantIndex } from "@/lib/push-variant";

const PAGE = 2000; // DB 조회 페이지 (전체 토큰을 메모리에 한 번에 올리지 않음)
const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 5; // 동시 FCM 호출 수
const STALE_MS = 5 * 60 * 1000; // 'processing' 에 멈춘 로그 재클레임 임계
const DRAIN_CONCURRENCY = 4; // 한 프로젝트에서 동시에 처리하는 로그 수
const FIRST_CURSOR = "00000000-0000-0000-0000-000000000000";
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000; // 빈도 상한 창
const CAP_RETENTION_MS = 25 * 60 * 60 * 1000; // 수신 기록 보존(창 + 여유)

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export { variantIndex };

/** 동시성 제한 map */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
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

// ─── 이어 보내기 상태 ────────────────────────────────────────────────────────

export type VariantStats = Record<string, { sent: number; success: number }>;

/**
 * push_logs.resume_cursor 에 페이지마다 남기는 진행 상태.
 * 커서만 두면 재클레임한 워커가 앞쪽 페이지의 성공·실패 수를 잃어 최종 집계가 줄어든다.
 * 분모(audience)도 처음 확정한 값을 들고 간다 — 이어 보낼 때 다시 세면 발송 중 변화가 섞인다.
 */
export type ResumeState = {
  cursor: string;
  total: number;
  success: number;
  failure: number;
  variantStats: VariantStats | null;
  audience: { users: number; devices: number };
  /** 있으면 발송 페이지는 끝났고 후속 단계 중이다 — 재클레임한 워커는 페이지를 건너뛰고 남은 단계만 돈다 */
  followUps?: FollowUps;
};

/** 후속 단계 완료 표시. 끝난 단계는 재클레임 때 다시 돌지 않는다. */
export type FollowUps = { inbox?: boolean; kakao?: boolean; webhook?: boolean };

const FOLLOW_UP_KEYS = ["inbox", "kakao", "webhook"] as const;

function parseFollowUps(v: unknown): FollowUps | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(FOLLOW_UP_KEYS.filter((k) => o[k] === true).map((k) => [k, true]));
}

export function initialState(audience: { users: number; devices: number }, variantCount: number | null): ResumeState {
  const variantStats: VariantStats | null = variantCount
    ? Object.fromEntries(Array.from({ length: variantCount }, (_, i) => [String(i), { sent: 0, success: 0 }]))
    : null;
  return { cursor: FIRST_CURSOR, total: 0, success: 0, failure: 0, variantStats, audience: { users: audience.users, devices: audience.devices } };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** 저장된 진행 상태 해석. 모양이 틀리면 null — 처음부터 다시 보내는 편이 틀린 커서로 건너뛰는 것보다 낫다. */
export function parseResumeState(raw: string | null | undefined): ResumeState | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const s = v as Record<string, unknown>;
  const aud = s.audience as Record<string, unknown> | undefined;
  if (typeof s.cursor !== "string" || !UUID_RE.test(s.cursor)) return null;
  if (!isCount(s.total) || !isCount(s.success) || !isCount(s.failure)) return null;
  if (!aud || !isCount(aud.users) || !isCount(aud.devices)) return null;
  const stats = s.variantStats;
  if (stats !== null && (typeof stats !== "object" || Array.isArray(stats))) return null;
  if (stats) {
    for (const x of Object.values(stats as Record<string, unknown>)) {
      const e = x as Record<string, unknown> | null;
      if (!e || !isCount(e.sent) || !isCount(e.success)) return null;
    }
  }
  return {
    cursor: s.cursor,
    total: s.total,
    success: s.success,
    failure: s.failure,
    variantStats: (stats as VariantStats | null) ?? null,
    audience: { users: aud.users, devices: aud.devices },
    ...(s.followUps !== undefined ? { followUps: parseFollowUps(s.followUps) ?? {} } : {}),
  };
}

// ─── 빈도 상한 ───────────────────────────────────────────────────────────────

/**
 * 최근 24시간 수신 수가 상한 이상인 사용자의 기기를 뺀다(순수 함수).
 * 익명 기기(userId null)는 사람 단위로 셀 수 없어 상한을 적용하지 않는다.
 */
export function applyFrequencyCap<T extends { userId: string | null }>(
  rows: T[],
  recentCounts: Map<string, number>,
  cap: number | null
): { allowed: T[]; capped: number } {
  if (cap === null) return { allowed: rows, capped: 0 };
  const allowed = rows.filter((r) => !r.userId || (recentCounts.get(r.userId) ?? 0) < cap);
  return { allowed, capped: rows.length - allowed.length };
}

/** 이 발송을 뺀 최근 24시간 수신 수. 같은 발송의 다른 페이지(한 사람의 여러 기기)가 상한에 걸리지 않게 한다. */
async function recentSendCounts(db: Db | Tx, logId: string, userIds: string[]): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .select({ userId: pushUserSends.userId, n: sql<number>`count(*)::int` })
    .from(pushUserSends)
    .where(
      and(
        inArray(pushUserSends.userId, userIds),
        gt(pushUserSends.sentAt, new Date(Date.now() - CAP_WINDOW_MS)),
        ne(pushUserSends.logId, logId)
      )
    )
    .groupBy(pushUserSends.userId);
  return new Map(rows.map((r) => [r.userId, Number(r.n)]));
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * 상한 판정과 수신 기록을 한 트랜잭션에서 — 보내기 **전에** 예약한다.
 * 판정과 기록이 떨어져 있으면 동시에 도는 다른 발송이 같은 사람을 함께 통과시킨다.
 * 프로젝트 단위 advisory lock 으로 같은 프로젝트의 예약을 줄 세운다.
 * `reserved` 는 이번에 새로 넣은 사람만 — 같은 발송의 앞 페이지가 넣은 기록은 되돌리지 않는다.
 */
async function reserveCapped(db: Db, log: PushLog, page: ScopedDevice[], cap: number): Promise<Admission> {
  const userIds = distinctUserIds(page);
  if (userIds.length === 0) return { allowed: page, reserved: [] };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${log.projectId}))`);
    const { allowed } = applyFrequencyCap(page, await recentSendCounts(tx, log.id, userIds), cap);
    const admitted = distinctUserIds(allowed);
    if (admitted.length === 0) return { allowed, reserved: [] };
    const rows = await tx
      .insert(pushUserSends)
      .values(admitted.map((userId) => ({ projectId: log.projectId, userId, logId: log.id })))
      .onConflictDoNothing()
      .returning({ userId: pushUserSends.userId });
    return { allowed, reserved: rows.map((r) => r.userId) };
  });
}

type Admission = { allowed: ScopedDevice[]; reserved: string[] };

/** 페이지에서 보낼 기기. 로그 전용 모드(서비스 계정 없음)는 실제로 받는 사람이 없으니 걸러내기만 하고 예약하지 않는다. */
async function admitPage(db: Db, log: PushLog, ctx: SendContext, page: ScopedDevice[]): Promise<Admission> {
  if (ctx.cap === null) return { allowed: page, reserved: [] };
  if (ctx.sa) return reserveCapped(db, log, page, ctx.cap);
  const counts = await recentSendCounts(db, log.id, distinctUserIds(page));
  return { allowed: applyFrequencyCap(page, counts, ctx.cap).allowed, reserved: [] };
}

/** 예약했지만 한 기기에도 배달되지 않은 사람 — 받은 게 없으니 상한에서 되돌린다(순수 함수). */
export function releasableUsers(
  reserved: string[],
  allowed: Array<{ token: string; userId: string | null }>,
  deliveredTokens: string[]
): string[] {
  const delivered = new Set(distinctUserIds(deliveredRows(allowed, deliveredTokens)));
  return reserved.filter((u) => !delivered.has(u));
}

async function releaseReservations(db: Db, logId: string, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  await db.delete(pushUserSends).where(and(eq(pushUserSends.logId, logId), inArray(pushUserSends.userId, userIds)));
}

async function purgeOldSends(db: Db, projectId: string): Promise<void> {
  await db
    .delete(pushUserSends)
    .where(and(eq(pushUserSends.projectId, projectId), lt(pushUserSends.sentAt, new Date(Date.now() - CAP_RETENTION_MS))));
}

/** 실제로 배달된 기기만(순수 함수) */
export function deliveredRows<T extends { token: string }>(rows: T[], deliveredTokens: string[]): T[] {
  const ok = new Set(deliveredTokens);
  return rows.filter((r) => ok.has(r.token));
}

function distinctUserIds(rows: Array<{ userId: string | null }>): string[] {
  return [...new Set(rows.map((r) => r.userId).filter((u): u is string => Boolean(u)))];
}

// ─── 보낼 내용 만들기 ────────────────────────────────────────────────────────

export type SendItem = { token: string; vi: number | null; title: string; body: string; dataOnly: boolean };

/**
 * 기기마다 보낼 내용: A/B 변형 배정 → 치환. 웹은 data-only(사유는 fcm.ts 의 dataOnly 참조).
 * `render` 가 없으면 치환하지 않는다(순수 함수).
 */
export function buildItems(
  rows: Array<Pick<ScopedDevice, "token" | "platform">>,
  base: { title: string; body: string },
  variants: { title: string; body: string }[] | null,
  render: ((text: string, token: string) => string) | null
): SendItem[] {
  return rows.map((r) => {
    const vi = variants ? variantIndex(r.token, variants.length) : null;
    const content = vi === null ? base : variants![vi];
    return {
      token: r.token,
      vi,
      title: render ? render(content.title, r.token) : content.title,
      body: render ? render(content.body, r.token) : content.body,
      dataOnly: r.platform === "web",
    };
  });
}

/** 같은 내용·같은 페이로드 모양끼리 묶어 멀티캐스트 배치로(최대 500) */
export function multicastGroups(items: SendItem[]): Array<Omit<SendItem, "token"> & { tokens: string[] }> {
  const groups = new Map<string, Omit<SendItem, "token"> & { tokens: string[] }>();
  for (const it of items) {
    const key = `${it.vi}\u0000${it.dataOnly}\u0000${it.title}\u0000${it.body}`;
    const g = groups.get(key) ?? { vi: it.vi, title: it.title, body: it.body, dataOnly: it.dataOnly, tokens: [] };
    g.tokens.push(it.token);
    groups.set(key, g);
  }
  return [...groups.values()].flatMap((g) => chunk(g.tokens, BATCH).map((tokens) => ({ ...g, tokens })));
}

function addVariantSent(stats: VariantStats | null, items: SendItem[]): VariantStats | null {
  if (!stats) return null;
  const next: VariantStats = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v }]));
  for (const it of items) if (it.vi !== null && next[String(it.vi)]) next[String(it.vi)].sent++;
  return next;
}

/** FCM 결과를 상태에 더한다(순수 함수). 변형별 성공은 성공 토큰의 변형으로 센다. */
export function tallyResults(state: ResumeState, items: SendItem[], results: FcmResult[]): ResumeState {
  const viOf = new Map(items.map((it) => [it.token, it.vi]));
  const stats = state.variantStats ? Object.fromEntries(Object.entries(state.variantStats).map(([k, v]) => [k, { ...v }])) : null;
  let success = state.success;
  let failure = state.failure;
  for (const r of results) {
    success += r.success;
    failure += r.failure;
    if (!stats) continue;
    for (const t of r.validTokens) {
      const vi = viOf.get(t);
      if (vi !== null && vi !== undefined && stats[String(vi)]) stats[String(vi)].success++;
    }
  }
  return { ...state, success, failure, variantStats: stats };
}

// ─── 발송 단계 ───────────────────────────────────────────────────────────────

type SendContext = {
  project: Project;
  sa: ServiceAccount | null;
  /** 테스트 발송은 null — 상한을 적용하지도, 수신 기록을 남기지도 않는다 */
  cap: number | null;
  renderCtx: RenderContext;
  personalized: boolean;
};

/** 치환용 — 토큰마다 받는 사람의 아이디·속성. 익명 기기는 null(기본값으로 채워진다). */
async function loadRecipients(db: Db, projectId: string, tokens: string[]): Promise<Map<string, Recipient>> {
  const rows = await db
    .select({
      token: devices.token,
      externalId: pushUsers.externalId,
      name: pushUsers.name,
      attributes: pushUsers.attributes,
      timezone: pushUsers.timezone,
      locale: pushUsers.locale,
    })
    .from(devices)
    .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
    .where(and(eq(devices.projectId, projectId), inArray(devices.token, tokens)));
  return new Map(
    rows.map((r) => [
      r.token,
      r.externalId
        ? { externalId: r.externalId, name: r.name, attributes: r.attributes, timezone: r.timezone, locale: r.locale }
        : null,
    ])
  );
}

async function claimLog(db: Db, logId: string, lockToken: string): Promise<PushLog | undefined> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const claimed = await db
    .update(pushLogs)
    .set({ status: "processing", lockedAt: now, lockToken })
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
  return claimed[0];
}

async function loadSendContext(db: Db, log: PushLog): Promise<SendContext | null> {
  const project = (await db.select().from(projects).where(eq(projects.id, log.projectId)).limit(1))[0];
  if (!project) return null;
  const sa = project.firebaseCredentialsEnc ? parseServiceAccount(decryptSecret(project.firebaseCredentialsEnc)) : null;
  const variants = log.variants ?? [];
  return {
    project,
    sa,
    cap: log.isTest ? null : project.frequencyCapPerDay,
    // 발송 한 건에 공통인 치환 값. 시각을 한 번 고정해야 페이지마다 {{time}} 이 달라지지 않는다.
    renderCtx: { appName: project.name, now: new Date() },
    personalized: hasPlaceholders(log.title, log.body, ...variants.flatMap((v) => [v.title, v.body])),
  };
}

/** 소유권 확인(하트비트) + 진행 상태 저장. 잃었으면 false — 즉시 중단해야 중복 발송이 없다. */
async function saveProgress(db: Db, logId: string, lockToken: string, state: ResumeState): Promise<boolean> {
  const hb = await db
    .update(pushLogs)
    .set({ lockedAt: new Date(), resumeCursor: JSON.stringify(state) })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  return hb.length > 0;
}

async function sendItems(ctx: SendContext, log: PushLog, items: SendItem[]): Promise<FcmResult[]> {
  const msgOf = (c: { title: string; body: string }): FcmMessage => ({
    title: c.title,
    body: c.body,
    imageUrl: log.imageUrl ?? undefined,
    deepLink: log.deepLink ?? undefined,
    logId: log.id,
    data: log.data ?? undefined,
    options: log.options ?? undefined,
  });
  const pid = ctx.project.id;
  const sa = ctx.sa!;
  // 치환이 있으면 사람마다 내용이 달라 묶이지 않는다 — 메시지 배열 한 번(sendEach)으로 보낸다
  const jobs: Array<() => Promise<FcmResult>> = ctx.personalized
    ? chunk(items, SEND_EACH_LIMIT).map((batch) => () =>
        sendEachToTokens(pid, sa, batch.map((it) => ({ token: it.token, msg: msgOf(it), dataOnly: it.dataOnly }))))
    : multicastGroups(items).map((g) => () => sendToTokens(pid, sa, g.tokens, msgOf(g), false, g.dataOnly));
  return mapLimit(jobs, CONCURRENCY, (job) => job());
}

/** 한 페이지 발송 → 다음 상태. 무효·검증 토큰은 페이지마다 반영한다(끝까지 모으면 메모리가 대상 수에 비례). */
async function sendPage(db: Db, log: PushLog, ctx: SendContext, page: ScopedDevice[], state: ResumeState): Promise<ResumeState> {
  const { allowed, reserved } = await admitPage(db, log, ctx, page);

  const recipients = ctx.personalized && allowed.length ? await loadRecipients(db, log.projectId, allowed.map((r) => r.token)) : null;
  const render = recipients
    ? (text: string, token: string) => renderTemplate(text, recipients.get(token) ?? null, ctx.renderCtx)
    : null;
  const items = buildItems(allowed, { title: log.title, body: log.body }, log.variants ?? null, render);

  let next: ResumeState = {
    ...state,
    cursor: page[page.length - 1].id,
    total: state.total + items.length,
    variantStats: addVariantSent(state.variantStats, items),
  };

  if (ctx.sa && items.length) {
    const results = await sendItems(ctx, log, items);
    next = tallyResults(next, items, results);
    await recordPageOutcome(db, log, results, releasableUsers(reserved, allowed, results.flatMap((r) => r.validTokens)));
  }
  return next;
}

/**
 * 발송 뒤 부수 기록. 이미 나간 페이지이므로 여기서 실패해도 커서 저장을 막으면 안 된다 —
 * 막으면 로그가 failed 로 끝나 재개되지 않거나, 재클레임 때 같은 페이지를 또 보낸다.
 */
async function recordPageOutcome(db: Db, log: PushLog, results: FcmResult[], releasable: string[]): Promise<void> {
  try {
    // 무효 토큰 비활성화 + **앱 삭제로 기록**. FCM 의 not-registered 판정이
    // 사실상 유일한 삭제 신호라, 여기서 버리면 삭제 추이를 볼 방법이 없다.
    const invalid = results.flatMap((r) => r.invalidTokens);
    const valid = results.flatMap((r) => r.validTokens);
    if (invalid.length) await recordUninstalls(db, log.projectId, invalid, "send");
    if (valid.length) await markVerified(db, log.projectId, valid);
    await releaseReservations(db, log.id, releasable);
  } catch (e) {
    console.warn(`[push] page bookkeeping failed for log ${log.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 대상 페이지를 커서부터 끝까지. 소유권을 잃으면 null. */
async function runPages(db: Db, log: PushLog, ctx: SendContext, lockToken: string): Promise<ResumeState | null> {
  // 분모는 **발송 시작 전에** 확정한다. 발송 뒤에 세면 그 사이의 구독 해지·바인딩 변경·
  // 무효토큰 비활성화가 반영되어, 실제로 받은 사람보다 작은(때로는 큰) 분모가 남는다.
  // 재클레임이면 저장된 상태(커서·누적·분모)에서 이어 간다.
  const resumed = parseResumeState(log.resumeCursor);
  if (resumed?.followUps) return resumed; // 발송은 이미 끝났다 — 남은 후속 단계만 돈다
  let state = resumed ?? initialState(await countAudience(db, log), log.variants?.length ?? null);
  const scope = await resolveScope(db, log);
  if (ctx.cap !== null) await purgeOldSends(db, log.projectId);
  if (!(await saveProgress(db, log.id, lockToken, state))) return null;
  if (!scope) return state;

  for (;;) {
    const page = await scopedDevicePage(db, scope, state.cursor, PAGE);
    if (page.length === 0) break;
    state = await sendPage(db, log, ctx, page, state);
    // 전달 보장은 페이지 단위 at-least-once — FCM 발송 후 이 커서 저장 전에 죽으면 그 페이지를 다시 보낸다
    if (!(await saveProgress(db, log.id, lockToken, state))) return null;
    if (page.length < PAGE) break;
  }
  return state;
}

/** 완료 처리 — 우리가 여전히 소유자일 때만(부작용 1회 보장). */
async function finalizeLog(db: Db, log: PushLog, lockToken: string, state: ResumeState, status: string): Promise<boolean> {
  const finalized = await db
    .update(pushLogs)
    .set({
      status,
      totalCount: state.total,
      successCount: state.success,
      failureCount: state.failure,
      audienceUserCount: state.audience.users,
      audienceDeviceCount: state.audience.devices,
      resumeCursor: null,
      ...(state.variantStats ? { variantStats: state.variantStats } : {}),
    })
    .where(and(eq(pushLogs.id, log.id), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  return finalized.length > 0;
}

type FollowUpUser = Recipient & { id: string; phone: string | null };

/** 후속 채널(인박스·알림톡)의 받는 사람 — 사람을 지정한 발송만, 수신거부한 사람은 뺀다 */
async function loadFollowUpUsers(db: Db, log: PushLog): Promise<FollowUpUser[]> {
  if (log.type !== "single" && log.type !== "multi") return [];
  const ids = log.type === "single" ? (log.target ? [log.target] : []) : (log.targets ?? []);
  if (ids.length === 0) return [];
  return db
    .select({
      id: pushUsers.id,
      externalId: pushUsers.externalId,
      name: pushUsers.name,
      attributes: pushUsers.attributes,
      timezone: pushUsers.timezone,
      locale: pushUsers.locale,
      phone: pushUsers.phone,
    })
    .from(pushUsers)
    .where(and(eq(pushUsers.projectId, log.projectId), inArray(pushUsers.externalId, ids), userNotSuppressed(log.projectId)));
}

/** In-app 인박스. (log, user) 유니크라 재실행해도 한 번만 쌓인다. */
async function deliverInbox(db: Db, log: PushLog, ctx: SendContext, users: FollowUpUser[]): Promise<void> {
  if (users.length === 0) return;
  await db
    .insert(notifications)
    .values(
      users.map((u) => ({
        projectId: log.projectId,
        userId: u.id,
        logId: log.id,
        title: renderTemplate(log.title, u, ctx.renderCtx),
        body: renderTemplate(log.body, u, ctx.renderCtx),
        deepLink: log.deepLink,
        data: log.data,
      }))
    )
    .onConflictDoNothing();
}

/** 카카오 알림톡 폴백: 단건만. device 발송 성공 0 + phone + 설정 존재 시 */
async function deliverKakaoFallback(db: Db, log: PushLog, ctx: SendContext, users: FollowUpUser[], success: number): Promise<void> {
  const u = log.type === "single" ? users[0] : undefined;
  if (!u || !log.kakaoFallback || !u.phone || !ctx.project.kakaoConfigEnc || success !== 0) return;
  try {
    const cfg = parseKakaoConfig(decryptSecret(ctx.project.kakaoConfigEnc));
    await assertSafeWebhookUrl(cfg.provider_url); // 발송 시점 SSRF 재검증(DNS 변경 대응)
    const text = `${renderTemplate(log.title, u, ctx.renderCtx)}\n${renderTemplate(log.body, u, ctx.renderCtx)}`;
    const r = await sendAlimtalk(cfg, u.phone, text);
    if (r.ok) await db.update(pushLogs).set({ kakaoCount: 1 }).where(eq(pushLogs.id, log.id));
    else console.warn(`[push] kakao fallback rejected for log ${log.id}`);
  } catch (e) {
    // 폴백 실패가 발송 완료를 되돌리지는 않지만, 조용히 삼키면 운영자가 원인을 알 수 없다(전화번호는 남기지 않는다)
    console.warn(`[push] kakao fallback failed for log ${log.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function notifySent(log: PushLog, status: string, state: ResumeState): Promise<void> {
  try {
    const data = { message_id: log.id, status, total: state.total, success: state.success, failure: state.failure };
    await emitWebhook(log.projectId, "message.sent", data);
  } catch (e) {
    console.warn(`[push] message.sent webhook failed for log ${log.id}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 후속 단계(인박스 → 알림톡 → 웹훅)를 **완료 표시 전에** 돈다. 완료 뒤에 돌면 그 사이에 죽었을 때 영영 유실된다.
 * 단계마다 끝났다는 표시를 resume_cursor 에 남겨, 재클레임한 워커는 남은 단계만 이어 간다.
 */
async function runFollowUps(db: Db, log: PushLog, ctx: SendContext, lockToken: string, sent: ResumeState, status: string): Promise<boolean> {
  let state: ResumeState = { ...sent, followUps: { ...sent.followUps } };
  if (!(await saveProgress(db, log.id, lockToken, state))) return false;
  const users = await loadFollowUpUsers(db, log);
  const steps: Record<keyof FollowUps, () => Promise<void>> = {
    inbox: () => deliverInbox(db, log, ctx, users),
    kakao: () => deliverKakaoFallback(db, log, ctx, users, state.success),
    webhook: () => notifySent(log, status, state),
  };
  for (const key of FOLLOW_UP_KEYS) {
    if (state.followUps?.[key]) continue;
    await steps[key]();
    state = { ...state, followUps: { ...state.followUps, [key]: true } };
    if (!(await saveProgress(db, log.id, lockToken, state))) return false;
  }
  return true;
}

async function failOwned(db: Db, logId: string, lockToken: string): Promise<void> {
  // 우리 소유일 때만 실패 표시 (새 워커의 클레임을 덮지 않음)
  await db.update(pushLogs).set({ status: "failed" }).where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)));
}

async function reload(db: Db, logId: string): Promise<PushLog | undefined> {
  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/**
 * 큐잉 로그 1건 처리. 원자적 클레임(+stale 'processing' 재클레임)으로 중복/유실 방지.
 * 대상은 페이지 스트리밍, 페이지마다 진행 상태를 남겨 재클레임 시 이어서 보낸다.
 * 크레덴셜 없으면 log-only.
 */
export async function processPushLog(logId: string): Promise<PushLog | undefined> {
  const db = getDb();
  const lockToken = randomUUID();
  const log = await claimLog(db, logId, lockToken);
  if (!log) return reload(db, logId); // 다른 워커가 이미 처리

  try {
    const ctx = await loadSendContext(db, log);
    if (!ctx) {
      // 프로젝트가 사라졌다(삭제 경합) — 보낼 곳이 없으니 실패로 닫는다
      await failOwned(db, logId, lockToken);
      return reload(db, logId);
    }
    const state = await runPages(db, log, ctx, lockToken);
    if (!state) return reload(db, logId); // 소유권 상실 → 새 소유자가 이어 간다

    const finalStatus = ctx.sa ? "completed" : "logged";
    if (!(await runFollowUps(db, log, ctx, lockToken, state, finalStatus))) return reload(db, logId);
    await finalizeLog(db, log, lockToken, state, finalStatus);
  } catch (e) {
    await failOwned(db, logId, lockToken);
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

  const results = await mapLimit(pending, DRAIN_CONCURRENCY, async ({ id }) => {
    try {
      await processPushLog(id);
      return true;
    } catch (e) {
      console.error(`[push] processing log ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  });
  const processed = results.filter(Boolean).length;
  return { processed, failed: results.length - processed };
}
