import { randomUUID } from "node:crypto";
import { and, eq, lt, gt, ne, inArray, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushLogs, projects, devices, pushClicks, pushHoldouts, pushUsers, pushUserSends, notifications, type PushLog } from "@/db/schema";
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
import { resolveLocaleContents } from "@/lib/locale-content";
import { holdoutScale, recordHoldout, splitHoldout } from "@/lib/holdout";
import { recordCanceledProgress } from "@/lib/push-cancel";
import {
  addErrors,
  addFallback,
  addHoldout,
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
import {
  abPart,
  abPlan,
  abResults,
  abScale,
  abTargets,
  abWinnerKey,
  decideWinner,
  inAbSample,
  type AbDecision,
  type AbTestPlan,
} from "@/lib/ab-test";
import { enqueuePush, type ReadyMessage } from "@/lib/messages";

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

/**
 * 이 발송에 적용할 분당 상한(순수 함수).
 * 발송이 값을 주면 그게 이긴다 — `0` 은 명시적 해제이므로 프로젝트 값으로 되돌리지 않는다.
 */
export function sendRateLimit(log: Pick<PushLog, "maxSendsPerMinute">, projectLimit: number | null): number | null {
  if (log.maxSendsPerMinute === null || log.maxSendsPerMinute === undefined) return projectLimit;
  return log.maxSendsPerMinute === 0 ? null : log.maxSendsPerMinute;
}

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

/** 토큰 → 로케일. 사람이 밝힌 값이 기기 등록값보다 정확하고, 기기를 바꿔도 따라간다. */
async function loadLocales(db: Db, projectId: string, tokens: string[]): Promise<Map<string, string | null>> {
  if (tokens.length === 0) return new Map();
  const rows = await db
    .select({ token: devices.token, locale: sql<string | null>`coalesce(${pushUsers.locale}, ${devices.locale})` })
    .from(devices)
    .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
    .where(and(eq(devices.projectId, projectId), inArray(devices.token, tokens)));
  return new Map(rows.map((r) => [r.token, r.locale]));
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
    // 캠페인별 재정의가 프로젝트 설정을 덮는다. 0 은 "이 발송은 제한 없음"이라
    // `?? project` 로 접으면 안 된다 — 그러면 명시적 해제가 조용히 프로젝트 값으로 돌아간다.
    rateLimit: log.isTest ? null : sendRateLimit(log, project.maxSendsPerMinute),
    localTime: log.isTest ? null : parseLocalTime(log.localTime),
    ab: log.isTest ? null : abPart(log.abTest),
    localeContent: log.localeVariants ?? null,
    holdoutPercent: log.isTest ? null : log.holdoutPercent,
    // 발송 한 건에 공통인 치환 값. 시각을 한 번 고정해야 페이지마다 {{time}} 이 달라지지 않는다.
    renderCtx: { appName: project.name, now: new Date() },
    // 로케일 문구도 본다 — 빠지면 기본 문구에 변수가 없을 때 한국어 사용자가 `{{name}}님` 을 그대로 받는다
    personalized: hasPlaceholders(
      log.title,
      log.body,
      ...variants.flatMap((v) => [v.title, v.body]),
      ...Object.values(log.localeVariants ?? {}).flatMap((t) => [t.title, t.body])
    ),
  };
}

/**
 * 한 실행이 페이지를 돌 때 들고 다니는 것 — 소유권·진행 상태·현지 시각 회차.
 * `state` 는 마지막으로 만든 진행 상태다. 소유권을 잃었을 때(취소) 여기 있는 수를 적어
 * "이미 나간 건수"가 한 페이지만큼 사라지는 것을 막는다.
 */
type Run = { ctx: SendContext; lockToken: string; progress: Progress; pass: LocalPass | null; state: ResumeState | null };

/** 현지 시각 발송: 지금 보낼 기기만 남긴다. 미룬 기기는 상한 예약 전에 빠져 슬롯을 태우지 않는다. */
async function dueDevices(db: Db, log: PushLog, run: Run, page: ScopedDevice[]): Promise<ScopedDevice[]> {
  if (!run.pass) return page;
  const zones = await loadZones(db, log.projectId, page.map((r) => r.token));
  return splitDue(run.pass, page, (r) => zones.get(r.token) ?? run.ctx.project.timezone).send;
}

/**
 * 보낼 내용 만들기 — 로케일 문구 배정 → 치환. 폴백 건수를 함께 돌려준다.
 * 로케일 조회는 `localeVariants` 가 있을 때만 — 없는 발송에 질의 한 번을 더 붙이지 않는다.
 */
async function pageItems(db: Db, log: PushLog, ctx: SendContext, allowed: ScopedDevice[]) {
  const base = { title: log.title, body: log.body };
  const locales = ctx.localeContent && allowed.length ? await loadLocales(db, log.projectId, allowed.map((r) => r.token)) : null;
  const picked = locales
    ? resolveLocaleContents(allowed, (t) => locales.get(t), ctx.localeContent, base)
    : null;
  const recipients = ctx.personalized && allowed.length ? await loadRecipients(db, log.projectId, allowed.map((r) => r.token)) : null;
  const render = recipients
    ? (text: string, token: string) => renderTemplate(text, recipients.get(token) ?? null, ctx.renderCtx)
    : null;
  return {
    items: buildItems(allowed, base, log.variants ?? null, render, picked?.contentOf ?? null),
    fallback: picked?.fallback ?? null,
  };
}

/** 한 페이지 발송 → 다음 상태. 무효·검증 토큰은 페이지마다 반영한다(끝까지 모으면 메모리가 대상 수에 비례). */
async function sendPage(db: Db, log: PushLog, run: Run, page: ScopedDevice[], state: ResumeState): Promise<ResumeState> {
  const ctx = run.ctx;
  const cursor = page[page.length - 1].id;
  // A/B 는 현지 시각보다 **먼저** 거른다 — 내 쪽이 아닌 기기는 회차 판정에도 끼면 안 된다
  const due = await dueDevices(db, log, run, abTargets(ctx.ab, page));
  const local = run.pass ? { local: passState(run.pass) } : {};
  // 홀드아웃은 상한 예약·속도 제한 예산보다 먼저 — 대조군이 남의 슬롯을 태우면 안 된다
  const { send: targets, held } = splitHoldout(due, ctx.holdoutPercent);
  if (held.length) await recordHoldout(db, log, held);
  const withHeld = addHoldout(state, held.length);
  if (targets.length === 0) return { ...withHeld, cursor, ...local };

  const { allowed, reserved } = await admitPage(db, log, ctx, targets);
  // 홀드아웃 실험이면 실제로 보내는 쪽도 남긴다 — 리프트를 대조군과 같은 규칙(받고 24시간 안의 전환)으로 잰다
  if (ctx.holdoutPercent && allowed.length) await recordHoldout(db, log, [], allowed);
  const { items, fallback } = await pageItems(db, log, ctx, allowed);

  let next: ResumeState = {
    ...(fallback ? addFallback(withHeld, fallback) : withHeld),
    cursor,
    ...local,
    total: withHeld.total + items.length,
    variantStats: addVariantSent(withHeld.variantStats, items),
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
  let state: ResumeState = resumed ?? initialState(holdoutScale(abAudience(await countAudience(db, log), ctx.ab), ctx.holdoutPercent), log.variants?.length ?? null, parseAttempts(progress.raw));
  state = { ...state, nextPageAt: undefined };
  run.state = state;
  // 하루 창은 **발송 시작 시각**부터 잰다 — 사흘 뒤로 예약한 발송을 큐잉 시각부터 재면 첫 회차부터
  // 창이 지난 것으로 보고 모든 시간대에 한꺼번에 보낸다
  const startedAt = Math.max(log.createdAt.getTime(), log.scheduledAt?.getTime() ?? 0);
  run.pass = ctx.localTime
    ? openLocalPass(ctx.localTime, state.local, now, now.getTime() - startedAt >= LOCAL_WINDOW_MS)
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
    run.state = state;
    if (window) await refundSendBudget(db, log.projectId, window, size - (state.total - before));
    if (page.length === 0) break;
    // 전달 보장은 페이지 단위 at-least-once — FCM 발송 후 이 커서 저장 전에 죽으면 그 페이지를 다시 보낸다
    if (!(await saveProgress(db, log.id, lockToken, state, progress))) return null;
    if (page.length < size) break;
  }
  return finishPass(db, log, run, state);
}

/**
 * A/B 발송의 분모 — 대상 전체가 아니라 이 발송이 맡은 쪽만 받는다.
 * 버킷이 정확히 비율대로 갈리지는 않으므로 어림값이지만, 전체 수를 그대로 두면
 * 표본 발송의 클릭률이 비율만큼 낮게 나와 판정보다 화면이 먼저 거짓말을 한다.
 */
function abAudience(a: { users: number; devices: number }, part: SendContext["ab"]) {
  return part ? { users: abScale(a.users, part), devices: abScale(a.devices, part) } : a;
}

/** 현지 시각 회차 마감 — 미룬 묶음이 있으면 커서를 처음으로 되돌리고 그 시각에 다시 깨어난다. */
async function finishPass(db: Db, log: PushLog, run: Run, state: ResumeState): Promise<PageRun | null> {
  if (!run.pass) return { state, deferredUntil: null };
  const local = closeLocalPass(run.pass);
  const next = { ...state, local, cursor: FIRST_CURSOR };
  // 회차는 닫혔다 — defer 가 열린 회차 상태(passState)로 덮어쓰지 않게 비운다. 덮어쓰면 이번 회차에
  // 보낸 묶음이 "보냄"에서 빠지고 지난 기준 시각이 남아, 다음 회차가 같은 사람들에게 다시 보낸다.
  run.pass = null;
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

/** 로그 행에 적는 집계 값 — 완료 처리와 중간 저장이 같은 값을 쓴다. */
function countColumns(state: ResumeState) {
  return {
    totalCount: state.total,
    successCount: state.success,
    failureCount: state.failure,
    audienceUserCount: state.audience.users,
    audienceDeviceCount: state.audience.devices,
    holdoutCount: state.holdout ?? 0,
    ...(state.errors ? { deliveryErrors: state.errors } : {}),
    ...(state.variantStats ? { variantStats: state.variantStats } : {}),
    ...(state.localeFallback ? { localeFallbacks: state.localeFallback } : {}),
  };
}

/** 완료 처리 — 우리가 여전히 소유자일 때만(부작용 1회 보장). */
async function finalizeLog(db: Db, log: PushLog, lockToken: string, state: ResumeState, status: string): Promise<boolean> {
  const finalized = await db
    .update(pushLogs)
    .set({ status, ...countColumns(state), resumeCursor: null })
    .where(and(eq(pushLogs.id, log.id), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  return finalized.length > 0;
}

/**
 * 아직 안 끝난 발송의 집계를 미리 적는다(상태·진행 상태는 건드리지 않는다).
 * A/B 판정 대기는 몇 시간이 될 수 있는데, 그동안 로그가 "0건 발송"으로 보이면
 * 운영자는 표본이 실제로 나갔는지조차 알 수 없다 — 변형별 결과도 여기서 먼저 보인다.
 */
async function saveCounts(db: Db, log: PushLog, lockToken: string, state: ResumeState): Promise<boolean> {
  const saved = await db
    .update(pushLogs)
    .set(countColumns(state))
    .where(and(eq(pushLogs.id, log.id), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  return saved.length > 0;
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

/**
 * 후속 채널(인박스·카카오)을 받을 사람 — 푸시를 받은 쪽과 같게 거른다.
 *
 * - 대조군(홀드아웃)은 뺀다: 인박스로 받으면 대조군이 아니게 되어 리프트 측정이 오염된다.
 * - A/B 는 이 발송이 맡은 버킷의 기기가 있는 사람만: 표본 로그와 승자 로그가 각각 대상 전원에게
 *   인박스를 넣으면 한 사람에게 두 통이 쌓인다. 기기가 없는 사람은 표본 쪽에 둔다 — 승자가 없으면
 *   나머지 발송 자체가 나가지 않으므로, 그쪽에 두면 아무 것도 받지 못한다.
 */
async function followUpRecipients(db: Db, log: PushLog, ctx: SendContext, users: FollowUpUser[]): Promise<FollowUpUser[]> {
  if (users.length === 0) return users;
  const ids = users.map((u) => u.id);
  const held = ctx.holdoutPercent
    ? new Set(
        (
          await db
            .select({ userId: pushHoldouts.userId })
            .from(pushHoldouts)
            .where(and(eq(pushHoldouts.logId, log.id), inArray(pushHoldouts.userId, ids)))
        ).map((r) => r.userId)
      )
    : new Set<string | null>();
  let kept = users.filter((u) => !held.has(u.id));
  const ab = ctx.ab;
  if (ab && kept.length) {
    const rows = await db
      .select({ userId: devices.userId, id: devices.id })
      .from(devices)
      .where(and(eq(devices.projectId, log.projectId), eq(devices.isActive, true), inArray(devices.userId, kept.map((u) => u.id))));
    const buckets = new Map<string, boolean[]>();
    for (const r of rows) if (r.userId) buckets.set(r.userId, [...(buckets.get(r.userId) ?? []), inAbSample(r.id, ab.samplePercent)]);
    const wantSample = ab.part === "sample";
    kept = kept.filter((u) => {
      const b = buckets.get(u.id);
      return b ? b.includes(wantSample) : wantSample;
    });
  }
  return kept;
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
  const users = await followUpRecipients(db, log, ctx, await loadFollowUpUsers(db, log));
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

// ─── A/B 자동 승자 ───────────────────────────────────────────────────────────

/** 판정 단계의 결과. `deferredUntil` 이면 그 시각에 다시 깨어나 판정한다. null 은 소유권 상실. */
type AbSettled = { deferredUntil: Date | null } | null;

/** 변형별 유니크 클릭 — push_clicks 는 (로그, 기기) 유니크라 행 수가 곧 유니크 클릭이다 */
async function abClicks(db: Db, logId: string): Promise<Map<number, number>> {
  const rows = await db
    .select({ variant: pushClicks.variant, n: sql<number>`count(*)::int` })
    .from(pushClicks)
    .where(eq(pushClicks.logId, logId))
    .groupBy(pushClicks.variant);
  return new Map(rows.flatMap((r) => (r.variant === null ? [] : [[r.variant, Number(r.n)] as [number, number]])));
}

/** 판정 결과를 로그에 굳힌다 — 우리가 아직 소유자일 때만 */
async function saveAbTest(db: Db, log: PushLog, lockToken: string, ab: AbTestPlan): Promise<boolean> {
  const rows = await db
    .update(pushLogs)
    .set({ abTest: ab })
    .where(and(eq(pushLogs.id, log.id), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  return rows.length > 0;
}

/**
 * 승자 본발송 — **나머지 버킷**에게 승자 변형의 내용으로 로그 1행.
 * 변형 없이 나가므로 받는 사람은 그냥 한 통을 받는다. 멱등 키가 있어 재판정에도 한 행만 생긴다.
 */
async function sendAbWinner(db: Db, log: PushLog, ctx: SendContext, plan: AbTestPlan, winner: number): Promise<string> {
  const content = (log.variants ?? [])[winner];
  if (!content) throw new Error(`ab winner ${winner} has no variant content`);
  const message: ReadyMessage = {
    type: log.type as ReadyMessage["type"],
    title: content.title,
    body: content.body,
    kakao_fallback: log.kakaoFallback,
    ...(log.target ? { target: log.target } : {}),
    ...(log.targets ? { targets: log.targets } : {}),
    ...(log.deepLink ? { deep_link: log.deepLink } : {}),
    ...(log.imageUrl ? { image_url: log.imageUrl } : {}),
    ...(log.data ? { data: log.data } : {}),
    ...(log.options ? { options: log.options } : {}),
    ...(log.localTime ? { local_time: log.localTime } : {}),
    // 대조군과 캠페인별 재정의는 승자 본발송에도 그대로 이어진다. 빠뜨리면 표본에서 빼 둔
    // 사람이 본발송을 받아 대조군이 사라지고, 거래성 발송이 다시 방해금지에 걸린다.
    ...(log.holdoutPercent ? { holdout_percent: log.holdoutPercent } : {}),
    ...(log.ignoreQuietHours ? { quiet_hours: false as const } : {}),
    ...(log.maxSendsPerMinute !== null ? { max_sends_per_minute: log.maxSendsPerMinute } : {}),
  };
  const { message: row } = await enqueuePush(ctx.project, message, {
    db,
    sentBy: "ab-winner",
    idempotencyKey: abWinnerKey(log.id),
    abTest: { role: "winner", parentLogId: log.id, samplePercent: plan.samplePercent, variant: winner },
  });
  return row.id;
}

/**
 * A/B 판정 단계 — 표본 발송이 끝난 **뒤에** 돈다.
 *
 * 스케줄러를 새로 두지 않는다: 판정 시각을 `ab_test.decideAt` 에 적고 로그를 반납하면
 * (`releaseLog` 가 `locked_at` 을 `at - STALE_MS` 로 적는다) 워커의 기존 큐 스캔이 정확히
 * 그 시각에 이 로그를 다시 집어 온다. 재클레임·at-least-once 규칙이 그대로 적용되고,
 * 판정이 두 번 돌아도 승자 본발송은 멱등 키 때문에 한 행뿐이다.
 */
async function settleAbTest(db: Db, log: PushLog, run: Run, state: ResumeState, now: Date): Promise<AbSettled> {
  // 승자 본발송(role:"winner")은 판정할 것이 없다 — 표본 쪽만 이 단계를 돈다
  const plan = run.ctx.ab?.part === "sample" ? abPlan(log.abTest) : null;
  if (!plan || plan.decision) return { deferredUntil: null };

  // 대기 시각은 **처음 한 번만** 정한다. 매번 now + wait 로 다시 잡으면 재클레임마다 판정이 미뤄진다.
  const decideAt = plan.decideAt ? new Date(plan.decideAt) : new Date(now.getTime() + plan.waitMinutes * 60_000);
  if (decideAt.getTime() > now.getTime()) {
    if (!(await saveCounts(db, log, run.lockToken, state))) return null;
    if (!(await saveAbTest(db, log, run.lockToken, { ...plan, decideAt: decideAt.toISOString() }))) return null;
    return { deferredUntil: decideAt };
  }

  const results = abResults(log.variants?.length ?? 0, state.variantStats, await abClicks(db, log.id));
  const decision: AbDecision = decideWinner(results, now);
  // 발송이 먼저, 기록이 나중 — 반대로 두면 기록만 남고 아무도 못 받는 판정이 생긴다
  const followUpLogId = decision.winner === null ? undefined : await sendAbWinner(db, log, run.ctx, plan, decision.winner);
  const settled: AbTestPlan = {
    ...plan,
    decideAt: decideAt.toISOString(),
    decision: { ...decision, ...(followUpLogId ? { followUpLogId } : {}) },
  };
  return (await saveAbTest(db, log, run.lockToken, settled)) ? { deferredUntil: null } : null;
}

async function reload(db: Db, logId: string): Promise<PushLog | undefined> {
  return (await db.select().from(pushLogs).where(eq(pushLogs.id, logId)).limit(1))[0];
}

/**
 * 소유권을 잃고 빠질 때. 취소로 잃은 것이면 **이 실행이 들고 있던 집계를 마저 적는다**.
 *
 * 취소는 그 순간의 `resume_cursor` 를 칼럼으로 굳히지만, 그 직전에 워커가 페이지 하나를 이미
 * FCM 에 넘겼을 수 있다(커서 저장 전에 취소가 들어온 경우). 그 수를 버리면 "실제로는 나갔는데
 * 로그에는 안 나간" 건이 생긴다 — 취소 화면이 가장 거짓말하기 쉬운 자리다.
 */
async function yieldOwnership(db: Db, logId: string, run: Run): Promise<PushLog | undefined> {
  const row = await reload(db, logId);
  if (row?.status !== "canceled" || !run.state) return row;
  await recordCanceledProgress(db, logId, run.state);
  return reload(db, logId);
}

/**
 * 말없이 죽은 실행을 시도 1회로 센다. 한도를 넘으면 닫고 true.
 * 세지 않으면 OOM 으로 죽는 발송이 5분마다 되살아나 같은 자리에서 영원히 다시 죽는다.
 */
async function countReclaim(db: Db, log: PushLog, lockToken: string, before: PushLog | undefined, progress: Progress): Promise<boolean> {
  const attempts = reclaimAttempts(before);
  if (attempts === null) return false;
  if (attempts >= MAX_SEND_ATTEMPTS) {
    await failPermanently(db, log.id, lockToken, `attempt ${attempts}/${MAX_SEND_ATTEMPTS}: worker died without recording a failure`, progress.raw);
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
    const run: Run = { ctx, lockToken, progress, pass: null, state: null };
    const paged = await runPages(db, log, run, new Date());
    // 소유권 상실 → 새 소유자가 이어 간다. 취소로 잃었으면 여기까지 나간 수를 적고 빠진다.
    if (!paged) return yieldOwnership(db, logId, run);
    if (paged.deferredUntil) {
      await releaseLog(db, logId, lockToken, paged.deferredUntil);
      return reload(db, logId);
    }

    const finalStatus = ctx.sa ? "completed" : "logged";
    run.state = paged.state;
    if (!(await runFollowUps(db, log, ctx, lockToken, paged.state, finalStatus, progress))) {
      return yieldOwnership(db, logId, run);
    }

    // A/B 표본 발송은 판정까지가 한 건이다 — 대기 중에는 완료로 닫지 않고 그 시각에 다시 깨어난다
    const settled = await settleAbTest(db, log, run, paged.state, new Date());
    if (!settled) return yieldOwnership(db, logId, run);
    if (settled.deferredUntil) {
      await releaseLog(db, logId, lockToken, settled.deferredUntil);
      return reload(db, logId);
    }
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
