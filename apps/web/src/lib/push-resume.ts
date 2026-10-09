/**
 * 발송 로그의 **진행 상태와 소유권** — 이어 보내기, 하트비트, 실패 정산, 반납.
 *
 * push-processor 에서 떼어 낸 이유: 여기 규칙(커서·시도 횟수·락)이 처리기 본문과 섞이면
 * "어디까지 보냈는가"와 "무엇을 보내는가"를 같이 고쳐야 해서 둘 다 위험해진다.
 */
import { and, eq, or, isNull, lt, lte, sql } from "drizzle-orm";
import { pushLogs, type PushLog } from "@/db/schema";
import type { Db } from "@/lib/audience-count";
import type { LocalState } from "@/lib/local-delivery";
import { addLocaleFallback, parseLocaleFallback, type LocaleFallback } from "@/lib/locale-content";

/** 'processing' 에 멈춘 로그를 다른 워커가 재클레임하는 임계 */
export const STALE_MS = 5 * 60 * 1000;
export const FIRST_CURSOR = "00000000-0000-0000-0000-000000000000";
/** 예외로 끝난 발송을 몇 번까지 되살릴지. 소진하면 사유와 함께 failed 로 닫는다. */
export const MAX_SEND_ATTEMPTS = 3;

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
  /**
   * 지금까지 예외로 끝난 시도 횟수. 일시적 실패(DB 순단·FCM 5xx)를 재시도하되 무한히 돌지 않게 하는 한도다.
   * 진행 상태와 같은 칼럼에 두는 이유: 재클레임한 워커가 커서와 시도 횟수를 **한 번에** 읽어야 한다.
   */
  attempts: number;
  /** 있으면 발송 페이지는 끝났고 후속 단계 중이다 — 재클레임한 워커는 페이지를 건너뛰고 남은 단계만 돈다 */
  followUps?: FollowUps;
  /** 속도 제한·현지 시각으로 미룬 발송이 다시 깨어날 시각(ISO) */
  nextPageAt?: string;
  /** 현지 시각 발송의 회차 상태 */
  local?: LocalState;
  /** 토큰별 실패 사유별 건수 — 끝나면 push_logs.delivery_errors 로 넘어간다 */
  errors?: Record<string, number>;
  /** 로케일 폴백 누적 — 끝나면 push_logs.locale_fallbacks 로 넘어간다 */
  localeFallback?: LocaleFallback;
  /** 홀드아웃으로 **보내지 않은** 기기 수 누적 */
  holdout?: number;
};

/** 후속 단계 완료 표시. 끝난 단계는 재클레임 때 다시 돌지 않는다. */
export type FollowUps = { inbox?: boolean; webhook?: boolean };

export const FOLLOW_UP_KEYS = ["inbox", "webhook"] as const;

function parseFollowUps(v: unknown): FollowUps | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(FOLLOW_UP_KEYS.filter((k) => o[k] === true).map((k) => [k, true]));
}

export function initialState(
  audience: { users: number; devices: number },
  variantCount: number | null,
  attempts = 0
): ResumeState {
  const variantStats: VariantStats | null = variantCount
    ? Object.fromEntries(Array.from({ length: variantCount }, (_, i) => [String(i), { sent: 0, success: 0 }]))
    : null;
  return {
    cursor: FIRST_CURSOR,
    total: 0,
    success: 0,
    failure: 0,
    variantStats,
    audience: { users: audience.users, devices: audience.devices },
    attempts,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const EMPTY_LOCAL: LocalState = { sentOffsets: [], passAt: null, nextPassAt: null };

function parseLocal(v: unknown): LocalState | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const offsets = Array.isArray(o.sentOffsets) ? o.sentOffsets.filter((x): x is string => typeof x === "string") : [];
  const sending = Array.isArray(o.sending) ? o.sending.filter((x): x is string => typeof x === "string") : [];
  return {
    sentOffsets: offsets,
    passAt: isIso(o.passAt) ? o.passAt : null,
    nextPassAt: isIso(o.nextPassAt) ? o.nextPassAt : null,
    ...(sending.length ? { sending } : {}),
  };
}

function parseErrors(v: unknown): Record<string, number> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out = Object.entries(v as Record<string, unknown>).filter(([, n]) => isCount(n)) as [string, number][];
  return out.length ? Object.fromEntries(out) : undefined;
}

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
  const errors = parseErrors(s.errors);
  const localeFallback = parseLocaleFallback(s.localeFallback);
  return {
    cursor: s.cursor,
    total: s.total,
    success: s.success,
    failure: s.failure,
    variantStats: (stats as VariantStats | null) ?? null,
    audience: { users: aud.users, devices: aud.devices },
    attempts: isCount(s.attempts) ? s.attempts : 0,
    ...(s.followUps !== undefined ? { followUps: parseFollowUps(s.followUps) ?? {} } : {}),
    ...(isIso(s.nextPageAt) ? { nextPageAt: s.nextPageAt } : {}),
    ...(s.local !== undefined ? { local: parseLocal(s.local) ?? EMPTY_LOCAL } : {}),
    ...(errors ? { errors } : {}),
    ...(localeFallback ? { localeFallback } : {}),
    ...(isCount(s.holdout) ? { holdout: s.holdout } : {}),
  };
}

/**
 * 시도 횟수만 읽는다. 진행 상태가 아직 없거나(첫 페이지 전에 죽음) 모양이 깨졌어도
 * 횟수는 살아 있어야 한다 — 그러지 않으면 같은 실패를 영원히 재시도한다.
 */
export function parseAttempts(raw: string | null | undefined): number {
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    return isCount(v?.attempts) ? v.attempts : 0;
  } catch {
    return 0;
  }
}

/** 시도 횟수만 갈아 끼운 진행 상태. 상태가 없거나 깨졌으면 횟수만 남긴다(다음 클레임이 처음부터 보낸다). */
export function withAttempts(raw: string | null, attempts: number): string {
  const state = parseResumeState(raw);
  return JSON.stringify(state ? { ...state, attempts } : { attempts });
}

export function addVariantSent(stats: VariantStats | null, items: Array<{ vi: number | null }>): VariantStats | null {
  if (!stats) return null;
  const next: VariantStats = Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v }]));
  for (const it of items) if (it.vi !== null && next[String(it.vi)]) next[String(it.vi)].sent++;
  return next;
}

/** 사유별 실패 건수 누적(순수 함수) */
export function addErrors(state: ResumeState, codes: string[]): ResumeState {
  if (codes.length === 0) return state;
  const errors = { ...(state.errors ?? {}) };
  for (const c of codes) errors[c] = (errors[c] ?? 0) + 1;
  return { ...state, errors };
}

/** 로케일 폴백 누적(순수 함수). 0건이면 상태를 건드리지 않아 없던 발송에 빈 칸이 생기지 않는다. */
export function addFallback(state: ResumeState, fallback: LocaleFallback): ResumeState {
  if (fallback.total === 0) return state;
  return { ...state, localeFallback: addLocaleFallback(state.localeFallback, fallback) };
}

/** 홀드아웃으로 뺀 기기 수 누적(순수 함수) */
export function addHoldout(state: ResumeState, n: number): ResumeState {
  return n <= 0 ? state : { ...state, holdout: (state.holdout ?? 0) + n };
}

/** FCM 결과를 상태에 더한다(순수 함수). 변형별 성공은 성공 토큰의 변형으로 센다. */
export function tallyResults(
  state: ResumeState,
  items: Array<{ token: string; vi: number | null }>,
  results: Array<{ success: number; failure: number; validTokens: string[] }>
): ResumeState {
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

/**
 * 워커가 지금 집어도 되는 로그 조건. **클레임과 큐 스캔이 같은 조건을 써야 한다** —
 * 한쪽만 `locked_at IS NULL` 을 빠뜨리면(SQL 비교는 NULL 을 참으로 만들지 않는다)
 * 클레임 직후 죽어 lockedAt 이 비어 있는 'processing' 행이 스캔에 영영 안 잡혀 발송이 멈춘다.
 * 일시적 실패로 되돌려 둔 로그도 이 조건의 stale 재클레임으로 이어진다.
 */
export function claimableLog(now: Date, staleBefore: Date) {
  return or(
    eq(pushLogs.status, "queued"),
    and(eq(pushLogs.status, "scheduled"), lte(pushLogs.scheduledAt, now)),
    and(eq(pushLogs.status, "processing"), or(isNull(pushLogs.lockedAt), lt(pushLogs.lockedAt, staleBefore)))
  );
}

/**
 * 이 실행이 마지막으로 **저장에 성공한** 진행 상태의 원문.
 *
 * 실패 정산이 DB 를 다시 읽지 않기 위해 존재한다: 읽으러 가는 순간이 바로 DB 가 죽은 순간이라
 * select 가 같이 터져 시도 횟수가 기록되지 않았고, 그래서 한도가 영원히 차지 않았다.
 */
export type Progress = { raw: string | null };

/** 소유권 확인(하트비트) + 진행 상태 저장. 잃었으면 false — 즉시 중단해야 중복 발송이 없다. */
export async function saveProgress(
  db: Db,
  logId: string,
  lockToken: string,
  state: ResumeState,
  progress?: Progress
): Promise<boolean> {
  const raw = JSON.stringify(state);
  const hb = await db
    .update(pushLogs)
    .set({ lockedAt: new Date(), resumeCursor: raw })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)))
    .returning({ id: pushLogs.id });
  if (hb.length === 0) return false;
  if (progress) progress.raw = raw;
  return true;
}

/** 남길 사유 길이 상한 — 스택이 통째로 들어와 로그 행이 비대해지는 걸 막는다 */
const FAILURE_REASON_MAX = 300;

function reasonOf(err: unknown, attempts: number): string {
  const msg = err instanceof Error ? err.message : String(err);
  return `attempt ${attempts}/${MAX_SEND_ATTEMPTS}: ${msg}`.slice(0, FAILURE_REASON_MAX);
}

/**
 * 실패로 닫을 때 그때까지 보낸 수 — 진행 상태에만 있고 로그 칸은 0 인 채로 닫히면
 * "10만 건 중 5만 건이 나간 뒤 실패"가 "아무에게도 안 나감"으로 남는다.
 * 줄어드는 쪽으로는 쓰지 않는다(취소 경로의 recordCanceledProgress 와 같은 규칙).
 */
function sentCounts(raw: string | null | undefined) {
  const state = parseResumeState(raw);
  if (!state) return {};
  return {
    totalCount: sql`greatest(${pushLogs.totalCount}, ${state.total})`,
    successCount: sql`greatest(${pushLogs.successCount}, ${state.success})`,
    failureCount: sql`greatest(${pushLogs.failureCount}, ${state.failure})`,
    holdoutCount: sql`greatest(${pushLogs.holdoutCount}, ${state.holdout ?? 0})`,
    audienceUserCount: state.audience.users,
    audienceDeviceCount: state.audience.devices,
  };
}

/** 다시 시도하지 않을 실패(대상이 사라진 경우 등) — 사유를 남기고 닫는다 */
export async function failPermanently(db: Db, logId: string, lockToken: string, reason: string, raw?: string | null): Promise<void> {
  // 우리 소유일 때만 실패 표시 (새 워커의 클레임을 덮지 않음)
  await db
    .update(pushLogs)
    .set({ status: "failed", failureReason: reason.slice(0, FAILURE_REASON_MAX), ...sentCounts(raw) })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)));
}

/**
 * 발송 중 터진 예외의 처리. 예전에는 무조건 `failed` 로 닫았는데, `failed` 는 클레임 대상도
 * 스캔 대상도 아니라 **DB 순단 한 번에 남은 대상 전체가 영영 발송되지 않았다** — resume_cursor 는
 * 멀쩡한 채로.
 *
 * 그래서 한도까지는 되살린다: 시도 횟수를 진행 상태에 적고 `processing` 그대로 둔다.
 * `locked_at` 은 마지막 하트비트 그대로 두어 stale 창(5분)이 지나면 다른 워커가 이어 간다 —
 * 이게 그대로 재시도 간격이 된다. 소유권 조건(lock_token)을 그대로 쓰므로 이미 남에게 넘어간
 * 로그는 건드리지 않는다. 한도를 소진하면 사유와 함께 `failed` 로 닫는다.
 *
 * `raw` 는 **이 실행이 들고 있던** 진행 상태다. 여기서 다시 읽지 않는다 — DB 가 죽어서 들어온
 * 경로인데 select 를 하면 그것도 같이 터져 시도 횟수가 기록되지 않는다(그러면 한도가 영원히
 * 차지 않아 마지막 페이지가 무한히 재발송된다).
 *
 * 되살리는 쪽에서는 `lock_token` 을 비운다 — 다음 재클레임이 이 실패를 "워커가 말없이 죽은 것"으로
 * 한 번 더 세지 않게 하는 표식이다(`reclaimAttempts` 참고).
 */
export async function settleFailure(db: Db, logId: string, lockToken: string, err: unknown, raw: string | null): Promise<boolean> {
  const attempts = parseAttempts(raw) + 1;
  const retryable = attempts < MAX_SEND_ATTEMPTS;
  await db
    .update(pushLogs)
    .set(
      retryable
        ? { resumeCursor: withAttempts(raw, attempts), lockToken: null }
        : { status: "failed", resumeCursor: withAttempts(raw, attempts), failureReason: reasonOf(err, attempts), ...sentCounts(raw) }
    )
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)));
  return retryable;
}

/**
 * 재클레임을 시도 1회로 센다. 프로세스가 통째로 죽으면(OOM·SIGKILL) 예외 처리가 돌지 않아
 * 시도 횟수가 안 올라가고, 그 로그는 5분마다 되살아나 같은 페이지에서 계속 죽는다 — 영원히.
 *
 * "말없이 죽었다"의 표식은 `lock_token` 이 남아 있는 `processing` 행이다. 스스로 실패를 적은
 * 경우(settleFailure)와 속도 제한으로 반납한 경우(releaseLog)는 토큰을 비우므로 여기 걸리지 않는다.
 * 세지 않을 상황이면 null.
 */
export function reclaimAttempts(before: Pick<PushLog, "status" | "lockToken" | "resumeCursor"> | undefined): number | null {
  if (!before || before.status !== "processing" || !before.lockToken) return null;
  return parseAttempts(before.resumeCursor) + 1;
}

/**
 * 로그 반납 — 지금은 보낼 수 없고(속도 제한·현지 시각) 나중에 이어야 한다.
 *
 * `locked_at` 을 `at - STALE_MS` 로 적는다. 클레임 조건이 "processing 이고 locked_at 이
 * 5분보다 오래됐다"이므로, 이 로그는 **정확히 `at` 에** 다시 집힌다. 지금 풀어 버리면(null)
 * 워커가 돌 때마다 집었다 놨다 하고, 미래 시각을 그대로 적으면 5분 더 늦게 깨어난다.
 * `lock_token` 은 비운다 — 크래시가 아니므로 시도 횟수로 세면 안 된다.
 */
export async function releaseLog(db: Db, logId: string, lockToken: string, at: Date): Promise<void> {
  await db
    .update(pushLogs)
    .set({ lockToken: null, lockedAt: new Date(at.getTime() - STALE_MS) })
    .where(and(eq(pushLogs.id, logId), eq(pushLogs.lockToken, lockToken)));
}
