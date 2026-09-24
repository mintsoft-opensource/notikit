import { randomUUID } from "node:crypto";
import { and, eq, lt, gt, ne, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushUsers, pushUserSends, notifications, type PushLog } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import type { FcmResult } from "@/lib/fcm";
import { emitWebhook, assertSafeWebhookUrl } from "@/lib/webhooks";
import { parseKakaoConfig, sendAlimtalk } from "@/lib/kakao";
import { recordUninstalls, markVerified } from "@/lib/device-events";
import { countAudience, resolveScope, scopedDevicePage, userNotSuppressed, type Db, type ScopedDevice } from "@/lib/audience-count";
import { hasPlaceholders, renderTemplate, type Recipient } from "@/lib/personalize";
import { variantIndex } from "@/lib/push-variant";
import {
  buildItems,
  chunk,
  dispatchItems,
  mapLimit,
  multicastGroups,
  type SendContext,
} from "@/lib/send-dispatch";
import {
  addErrors,
  addVariantSent,
  claimableLog,
  failPermanently,
  FIRST_CURSOR,
  FOLLOW_UP_KEYS,
  initialState,
  MAX_SEND_ATTEMPTS,
  parseAttempts,
  parseResumeState,
  reclaimAttempts,
  releaseLog,
  saveProgress,
  settleFailure,
  STALE_MS,
  tallyResults,
  withAttempts,
  type FollowUps,
  type Progress,
  type ResumeState,
} from "@/lib/push-resume";
import {
  closeLocalPass,
  loadZones,
  LOCAL_WINDOW_MS,
  openLocalPass,
  parseLocalTime,
  passState,
  splitDue,
  type LocalPass,
} from "@/lib/local-delivery";
import { nextWindow, purgeRateWindows, refundSendBudget, reserveSendBudget } from "@/lib/send-throttle";

const PAGE = 2000; // DB 조회 페이지 (전체 토큰을 메모리에 한 번에 올리지 않음)
const DRAIN_CONCURRENCY = 4; // 한 프로젝트에서 동시에 처리하는 로그 수
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000; // 빈도 상한 창
const CAP_RETENTION_MS = 25 * 60 * 60 * 1000; // 수신 기록 보존(창 + 여유)

export { variantIndex, chunk, mapLimit, buildItems, multicastGroups };
export {
  addVariantSent,
  claimableLog,
  initialState,
  MAX_SEND_ATTEMPTS,
  parseAttempts,
  parseResumeState,
  reclaimAttempts,
  saveProgress,
  settleFailure,
  tallyResults,
} from "@/lib/push-resume";
export type { FollowUps, Progress, ResumeState, VariantStats } from "@/lib/push-resume";
export type { SendContext, SendItem } from "@/lib/send-dispatch";

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
export async function reserveCapped(db: Db, log: PushLog, page: ScopedDevice[], cap: number): Promise<Admission> {
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

// ─── 발송 단계 ───────────────────────────────────────────────────────────────

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
  const claimed = await db
    .update(pushLogs)
    .set({ status: "processing", lockedAt: now, lockToken })
    .where(and(eq(pushLogs.id, logId), claimableLog(now, new Date(now.getTime() - STALE_MS))))
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
    // 테스트 발송은 운영자가 지금 받아 보려는 것이다 — 상한도 속도 제한도 현지 시각도 걸지 않는다
    cap: log.isTest ? null : project.frequencyCapPerDay,
    rateLimit: log.isTest ? null : project.maxSendsPerMinute,
    localTime: log.isTest ? null : parseLocalTime(log.localTime),
    // 발송 한 건에 공통인 치환 값. 시각을 한 번 고정해야 페이지마다 {{time}} 이 달라지지 않는다.
    renderCtx: { appName: project.name, now: new Date() },
    personalized: hasPlaceholders(log.title, log.body, ...variants.flatMap((v) => [v.title, v.body])),
  };
}

/** 한 실행이 페이지를 돌 때 들고 다니는 것 — 소유권·진행 상태·현지 시각 회차 */
type Run = { ctx: SendContext; lockToken: string; progress: Progress; pass: LocalPass | null };

/** 현지 시각 발송: 지금 보낼 기기만 남긴다. 미룬 기기는 상한 예약 전에 빠져 슬롯을 태우지 않는다. */
async function dueDevices(db: Db, log: PushLog, run: Run, page: ScopedDevice[]): Promise<ScopedDevice[]> {
  if (!run.pass) return page;
  const zones = await loadZones(db, log.projectId, page.map((r) => r.token));
  return splitDue(run.pass, page, (r) => zones.get(r.token) ?? run.ctx.project.timezone).send;
}

/** 한 페이지 발송 → 다음 상태. 무효·검증 토큰은 페이지마다 반영한다(끝까지 모으면 메모리가 대상 수에 비례). */
async function sendPage(db: Db, log: PushLog, run: Run, page: ScopedDevice[], state: ResumeState): Promise<ResumeState> {
  const ctx = run.ctx;
  const cursor = page[page.length - 1].id;
  const targets = await dueDevices(db, log, run, page);
  const local = run.pass ? { local: passState(run.pass) } : {};
  if (targets.length === 0) return { ...state, cursor, ...local };

  const { allowed, reserved } = await admitPage(db, log, ctx, targets);
  const recipients = ctx.personalized && allowed.length ? await loadRecipients(db, log.projectId, allowed.map((r) => r.token)) : null;
  const render = recipients
    ? (text: string, token: string) => renderTemplate(text, recipients.get(token) ?? null, ctx.renderCtx)
    : null;
  const items = buildItems(allowed, { title: log.title, body: log.body }, log.variants ?? null, render);

  let next: ResumeState = {
    ...state,
    cursor,
    ...local,
    total: state.total + items.length,
    variantStats: addVariantSent(state.variantStats, items),
  };

  if (ctx.sa && items.length) {
    const { result, errors } = await dispatchItems(ctx, log, items);
    next = addErrors(tallyResults(next, items, [result]), errors);
    await recordPageOutcome(db, log, [result], releasableUsers(reserved, allowed, result.validTokens));
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

/** 페이지 루프의 결과. `deferredUntil` 이면 아직 끝나지 않았고 그 시각에 이어야 한다. */
type PageRun = { state: ResumeState; deferredUntil: Date | null };

/** 이번 페이지에 쓸 예산. 제한이 없으면 PAGE 그대로. */
async function pageBudget(db: Db, log: PushLog, limit: number | null): Promise<{ size: number; window: Date | null }> {
  if (limit === null) return { size: PAGE, window: null };
  const { granted, window } = await reserveSendBudget(db, log.projectId, limit, PAGE);
  return { size: granted, window };
}

/** 대상 페이지를 커서부터 끝까지. 소유권을 잃으면 null. */
async function runPages(db: Db, log: PushLog, run: Run, now: Date): Promise<PageRun | null> {
  // 분모는 **발송 시작 전에** 확정한다. 발송 뒤에 세면 그 사이의 구독 해지·바인딩 변경·
  // 무효토큰 비활성화가 반영되어, 실제로 받은 사람보다 작은(때로는 큰) 분모가 남는다.
  // 재클레임이면 저장된 상태(커서·누적·분모)에서 이어 간다.
  const { ctx, lockToken, progress } = run;
  const resumed = parseResumeState(progress.raw);
  if (resumed?.followUps) return { state: resumed, deferredUntil: null }; // 발송은 이미 끝났다
  // 미뤄 둔 시각 전에 집혔으면(스캔 경합) 아무 일도 하지 않고 그대로 다시 반납한다
  const waitUntil = resumed?.nextPageAt ? new Date(resumed.nextPageAt) : null;
  if (waitUntil && waitUntil.getTime() > now.getTime()) return { state: resumed!, deferredUntil: waitUntil };

  // 상태가 깨졌어도 시도 횟수는 이어받는다 — 아니면 같은 실패를 한도 없이 반복한다
  let state: ResumeState = resumed ?? initialState(await countAudience(db, log), log.variants?.length ?? null, parseAttempts(progress.raw));
  state = { ...state, nextPageAt: undefined };
  run.pass = ctx.localTime
    ? openLocalPass(ctx.localTime, state.local, now, now.getTime() - log.createdAt.getTime() >= LOCAL_WINDOW_MS)
    : null;

  const scope = await resolveScope(db, log);
  if (ctx.cap !== null) await purgeOldSends(db, log.projectId);
  if (ctx.rateLimit !== null) await purgeRateWindows(db, log.projectId, now);
  if (!(await saveProgress(db, log.id, lockToken, state, progress))) return null;
  if (!scope) return { state, deferredUntil: null };

  for (;;) {
    const { size, window } = await pageBudget(db, log, ctx.rateLimit);
    // 예산 소진: 루프 안에서 기다리면 stale 창을 넘겨 다른 워커가 같은 페이지를 또 보낸다
    if (size === 0) return defer(db, log, run, state, nextWindow(new Date()));
    const page = await scopedDevicePage(db, scope, state.cursor, size);
    const before = state.total;
    if (page.length > 0) state = await sendPage(db, log, run, page, state);
    if (window) await refundSendBudget(db, log.projectId, window, size - (state.total - before));
    if (page.length === 0) break;
    // 전달 보장은 페이지 단위 at-least-once — FCM 발송 후 이 커서 저장 전에 죽으면 그 페이지를 다시 보낸다
    if (!(await saveProgress(db, log.id, lockToken, state, progress))) return null;
    if (page.length < size) break;
  }
  return finishPass(db, log, run, state);
}

/** 현지 시각 회차 마감 — 미룬 묶음이 있으면 커서를 처음으로 되돌리고 그 시각에 다시 깨어난다. */
async function finishPass(db: Db, log: PushLog, run: Run, state: ResumeState): Promise<PageRun | null> {
  if (!run.pass) return { state, deferredUntil: null };
  const local = closeLocalPass(run.pass);
  const next = { ...state, local, cursor: FIRST_CURSOR };
  if (!local.nextPassAt) return { state: next, deferredUntil: null };
  return defer(db, log, run, next, new Date(local.nextPassAt));
}

/** 지금은 더 못 보낸다 — 다시 깨어날 시각을 상태에 적고 반납을 예고한다(반납 자체는 호출부에서). */
async function defer(db: Db, log: PushLog, run: Run, state: ResumeState, at: Date): Promise<PageRun | null> {
  // 회차 기준 시각을 함께 굳힌다 — 없으면 이어받은 워커가 새 회차를 열어 커서 앞쪽을 건너뛴다
  const local = run.pass ? { local: passState(run.pass) } : {};
  const next: ResumeState = { ...state, ...local, nextPageAt: at.toISOString() };
  if (!(await saveProgress(db, log.id, run.lockToken, next, run.progress))) return null;
  return { state: next, deferredUntil: at };
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
      ...(state.errors ? { deliveryErrors: state.errors } : {}),
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

/**
 * message.sent 웹훅. **삼키지 않는다.**
 *
 * emitWebhook 은 배달 행을 넣고 같은 요청에서 한 번 쏜다. 전송 실패는 행에 기록되어 재시도 스윕이
 * 회수하지만, 행을 넣기 **전에** 터지면(DB 순단) 회수할 근거 자체가 없다 — 스윕은 행을 보고 돈다.
 * 예전에는 그 예외를 삼키고 단계를 완료로 표시해, 그 이벤트가 영영 사라졌다.
 * 그래서 던진다: 단계가 완료로 표시되지 않고, 로그는 `processing` 으로 남아 재클레임이 이 단계만
 * 다시 돈다(앞선 인박스·알림톡은 표시가 남아 건너뛴다).
 *
 * 대가로 웹훅이 **중복 배달**될 수 있다(행을 넣은 구독과 못 넣은 구독이 섞인 경우). 발송 자체가
 * at-least-once 이므로 같은 약속이고, 구독자는 배달 id 로 중복을 거를 수 있다.
 */
async function notifySent(log: PushLog, status: string, state: ResumeState): Promise<void> {
  const data = { message_id: log.id, status, total: state.total, success: state.success, failure: state.failure };
  try {
    await emitWebhook(log.projectId, "message.sent", data);
  } catch (e) {
    console.warn(`[push] message.sent webhook failed for log ${log.id}: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/**
 * 후속 단계(인박스 → 알림톡 → 웹훅)를 **완료 표시 전에** 돈다. 완료 뒤에 돌면 그 사이에 죽었을 때 영영 유실된다.
 * 단계마다 끝났다는 표시를 resume_cursor 에 남겨, 재클레임한 워커는 남은 단계만 이어 간다.
 */
export async function runFollowUps(
  db: Db,
  log: PushLog,
  ctx: SendContext,
  lockToken: string,
  sent: ResumeState,
  status: string,
  progress?: Progress
): Promise<boolean> {
  let state: ResumeState = { ...sent, followUps: { ...sent.followUps } };
  if (!(await saveProgress(db, log.id, lockToken, state, progress))) return false;
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
    if (!(await saveProgress(db, log.id, lockToken, state, progress))) return false;
  }
  return true;
}

async function reload(db: Db, logId: string): Promise<PushLog | undefined> {
  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/**
 * 말없이 죽은 실행을 시도 1회로 센다. 한도를 넘으면 닫고 true.
 * 세지 않으면 OOM 으로 죽는 발송이 5분마다 되살아나 같은 자리에서 영원히 다시 죽는다.
 */
async function countReclaim(db: Db, log: PushLog, lockToken: string, before: PushLog | undefined, progress: Progress): Promise<boolean> {
  const attempts = reclaimAttempts(before);
  if (attempts === null) return false;
  if (attempts >= MAX_SEND_ATTEMPTS) {
    await failPermanently(db, log.id, lockToken, `attempt ${attempts}/${MAX_SEND_ATTEMPTS}: worker died without recording a failure`);
    return true;
  }
  const raw = withAttempts(progress.raw, attempts);
  await db.update(pushLogs).set({ resumeCursor: raw }).where(and(eq(pushLogs.id, log.id), eq(pushLogs.lockToken, lockToken)));
  progress.raw = raw;
  return false;
}

/**
 * 큐잉 로그 1건 처리. 원자적 클레임(+stale 'processing' 재클레임)으로 중복/유실 방지.
 * 대상은 페이지 스트리밍, 페이지마다 진행 상태를 남겨 재클레임 시 이어서 보낸다.
 * 크레덴셜 없으면 log-only.
 */
export async function processPushLog(logId: string): Promise<PushLog | undefined> {
  const db = getDb();
  const lockToken = randomUUID();
  // 클레임 **전**의 행 — 앞선 실행이 어떻게 끝났는지(말없이 죽었는지)는 이 값으로만 알 수 있다
  const before = await reload(db, logId);
  const log = await claimLog(db, logId, lockToken);
  if (!log) return before ?? reload(db, logId); // 다른 워커가 이미 처리
  const progress: Progress = { raw: log.resumeCursor };

  try {
    if (await countReclaim(db, log, lockToken, before, progress)) return reload(db, logId);
    const ctx = await loadSendContext(db, log);
    if (!ctx) {
      // 프로젝트가 사라졌다(삭제 경합) — 다시 해도 결과가 같으니 재시도 없이 닫는다
      await failPermanently(db, logId, lockToken, "project not found");
      return reload(db, logId);
    }
    const run: Run = { ctx, lockToken, progress, pass: null };
    const paged = await runPages(db, log, run, new Date());
    if (!paged) return reload(db, logId); // 소유권 상실 → 새 소유자가 이어 간다
    if (paged.deferredUntil) {
      await releaseLog(db, logId, lockToken, paged.deferredUntil);
      return reload(db, logId);
    }

    const finalStatus = ctx.sa ? "completed" : "logged";
    if (!(await runFollowUps(db, log, ctx, lockToken, paged.state, finalStatus, progress))) return reload(db, logId);
    await finalizeLog(db, log, lockToken, paged.state, finalStatus);
  } catch (e) {
    // 한도 안이면 'processing' 으로 남아 stale 재클레임으로 이어진다.
    // 진행 상태를 여기서 다시 읽지 않는다 — DB 가 죽어서 들어온 경로라 그 select 가 같이 터진다.
    const retryable = await settleFailure(db, logId, lockToken, e, progress.raw);
    if (!retryable) console.error(`[push] log ${logId} gave up after ${MAX_SEND_ATTEMPTS} attempts`);
    throw e;
  }

  return reload(db, logId);
}

/** 큐잉 + stale 로그를 동시성 제한으로 처리 (worker/cron 진입점) */
export async function drainQueue(projectId: string, limit = 50): Promise<{ processed: number; failed: number }> {
  const db = getDb();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  const pending = await db
    .select({ id: pushLogs.id })
    .from(pushLogs)
    .where(and(eq(pushLogs.projectId, projectId), claimableLog(now, staleBefore)))
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
