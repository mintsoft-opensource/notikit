import { eq, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { auditLogs, projects } from "@/db/schema";
import { clientIp, maskIp } from "@/lib/client-ip";
import { fail } from "@/lib/api-response";
import { getAuthContext, type AuthContext } from "@/lib/authz";
import { log, errorMessage } from "@/lib/logger";
import {
  AUDIT_ACTIONS,
  DENIED_SUFFIX,
  actionFilter,
  type AuditAction,
  type AuditDiff,
  type AuditTargetType,
} from "@/lib/audit-shared";

// 순수 부분은 클라이언트도 쓴다(콘솔이 이 파일을 끌어오면 DB 클라이언트가 번들에 섞인다).
// 테이블은 schema.ts 소유다(마이그레이션 0028). 여기서는 다시 내보내기만 한다 —
// 감사 관련 코드가 스키마 모듈을 직접 끌어오지 않게 해서 컬럼명이 바뀌어도 한 곳만 고치면 된다.
export { auditLogs } from "@/db/schema";
export {
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  DENIED_SUFFIX,
  actionFilter,
  baseAction,
  isDenied,
} from "@/lib/audit-shared";
export type { AuditAction, AuditDiff, AuditTargetType, AuditEntryDto, DiffEntry } from "@/lib/audit-shared";

export const REDACTED = "[redacted]";

/**
 * 값을 보지 않고 **키 이름만으로** 가리는 항목. logger.ts 와 같은 방식이다 —
 * 값 패턴으로 판정하면 새 비밀 형식이 생길 때마다 조용히 새어 나간다.
 */
const SENSITIVE_KEY =
  /(secret|token|password|passwd|hash|credential|api[-_]?key|authorization|cookie|bearer|private[-_]?key|salt|signature|identity|phone|tel|mobile|msisdn)/i;

/** 전화번호로 보이는 값 — 키 이름이 무해해도(external_id 등) 원문을 남기지 않는다. */
const PHONE_LIKE = /^\+?[0-9][0-9 ().-]{6,20}$/;

const MAX_STRING = 512;
const MAX_ARRAY = 50;
const MAX_DEPTH = 4;

function digitsOf(v: string): string {
  return v.replace(/\D/g, "");
}

/**
 * 전화번호 판정. 길이만 보면 주문번호·회원번호가 전부 걸리므로 구분 기호까지 본다.
 * 국제 표기(+)가 있거나 구분 기호가 섞였거나, 순수 숫자 10~15자리면 전화로 본다.
 */
export function looksLikePhone(v: string): boolean {
  const s = v.trim();
  if (!PHONE_LIKE.test(s)) return false;
  const d = digitsOf(s);
  if (d.length < 8 || d.length > 15) return false;
  if (s.startsWith("+")) return true;
  if (/[ ().-]/.test(s)) return true;
  return d.length >= 10;
}

/** 전화번호는 뒤 4자리만 남긴다 — 전부 지우면 "누구를 막았는지" 를 못 읽고, 그대로 두면 개인정보다. */
function maskPhone(v: string): string {
  return `[phone …${digitsOf(v).slice(-4)}]`;
}

function redactString(v: string): string {
  if (looksLikePhone(v)) return maskPhone(v);
  return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…(+${v.length - MAX_STRING})` : v;
}

/**
 * 저장 전 정화. 새 객체를 만들어 돌려준다 — 입력을 제자리에서 고치면 호출부가 방금
 * DB 에 쓴 값을 감사용으로 가려진 값으로 바꿔 버린다.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DEPTH) return "[deep]";

  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ARRAY).map((v) => redactValue(v, depth + 1));
    return value.length > MAX_ARRAY ? [...head, `…(+${value.length - MAX_ARRAY} more)`] : head;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  } catch {
    return false;
  }
}

function redactField(key: string, value: unknown): unknown {
  return SENSITIVE_KEY.test(key) ? REDACTED : redactValue(value);
}

type Rec = Record<string, unknown>;

/**
 * 변경 전/후 diff. **바뀐 필드만** 담고, 각 필드는 항상 before 와 after 를 모두 갖는다.
 *
 * - 생성: before = null (모든 필드)
 * - 삭제: after = null (모든 필드)
 * - 수정: 값이 실제로 달라진 필드만
 *
 * 바뀐 것이 없으면 null 을 돌려준다 — 아무것도 안 바뀐 요청까지 "수정함" 으로 적으면
 * 목록이 잡음으로 차서 진짜 변경을 못 찾는다.
 */
export function buildDiff(before: Rec | null | undefined, after: Rec | null | undefined): AuditDiff | null {
  const out: AuditDiff = {};

  if (!before && after) {
    for (const [k, v] of Object.entries(after)) {
      if (v === undefined) continue;
      out[k] = { before: null, after: redactField(k, v) };
    }
  } else if (before && !after) {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) continue;
      out[k] = { before: redactField(k, v), after: null };
    }
  } else if (before && after) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      // undefined 는 "이 요청이 건드리지 않은 필드" 다 — null(값을 비움)과 구분한다
      if (after[k] === undefined) continue;
      if (sameValue(before[k], after[k])) continue;
      out[k] = { before: redactField(k, before[k] ?? null), after: redactField(k, after[k]) };
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** 트랜잭션 안에서 기록해야 하는 곳(가져오기 배치)이 있어 tx 도 받는다. */
export type AuditDb = Db | Tx;

export type AuditEntry = {
  /**
   * 프로젝트 스코프 행위면 프로젝트 id. 멤버 추가처럼 org 단위 행위면 null 이다
   * (`project_id` 가 nullable 이라 프로젝트마다 복제하지 않아도 된다).
   */
  projectId: string | null;
  /** 프로젝트를 아는 경우 생략 가능 — org 를 SQL 안에서 찾아 넣는다. */
  orgId?: string | null;
  /** 인증 컨텍스트. superadmin 토큰이면 사용자 id 가 없다. */
  actor: AuthContext | null;
  action: string;
  targetType?: AuditTargetType | null;
  targetId?: string | null;
  /** 필드별 변경 전/후. `audit_logs.metadata` 에 들어간다. */
  diff?: AuditDiff | null;
  /** 요청 — 있으면 마스킹한 IP 를 함께 남긴다(원본은 개인정보라 저장하지 않는다). */
  req?: Request;
  /** 같은 트랜잭션에 묶어야 할 때(가져오기 배치 — 배치 id 가 없으면 되돌릴 수 없다) */
  db?: AuditDb;
};

/** 행위자 표시값. 계정이 지워져도 그 시점의 이메일이 남도록 SQL 안에서 푼다(왕복 없음). */
function actorSql(actor: AuthContext | null) {
  if (!actor) return sql`'system'`;
  if (!actor.userId) return sql`'admin-token'`;
  return sql`coalesce((select email from admin_users where id = ${actor.userId}::uuid), 'deleted-user')`;
}

/** org 를 따로 조회하지 않는다 — 프로젝트를 알면 한 문장 안에서 찾는다. */
function orgSql(entry: AuditEntry) {
  if (entry.orgId) return sql`${entry.orgId}::uuid`;
  if (entry.actor?.orgId) return sql`${entry.actor.orgId}::uuid`;
  return sql`(select org_id from projects where id = ${entry.projectId}::uuid)`;
}

function maskedIp(req?: Request): string | null {
  if (!req) return null;
  const ip = clientIp(req);
  return ip ? maskIp(ip) : null;
}

/**
 * 감사 기록. **실패해도 요청을 깨뜨리지 않는다** — 감사 테이블 장애로 발송 설정 변경이
 * 막히면 운영이 멈춘다. 대신 반드시 로그로 남겨 유실을 눈에 보이게 한다.
 *
 * 성공 경로에서 await 한다(뒤로 던져두면 응답 후 프로세스가 내려갈 때 조용히 사라진다).
 */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  const db = entry.db ?? getDb();
  try {
    await db.insert(auditLogs).values({
      orgId: orgSql(entry) as unknown as string,
      projectId: entry.projectId,
      actor: actorSql(entry.actor) as unknown as string,
      actorUserId: entry.actor?.userId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: entry.diff ?? null,
      ipMasked: maskedIp(entry.req),
    });
  } catch (e) {
    // tx 안에서 터지면 바깥 트랜잭션도 되돌려야 한다 — 배치 id 없는 가져오기는 되돌릴 수 없다
    if (entry.db) throw e;
    log.error("audit_write_failed", { action: entry.action, project_id: entry.projectId, error: errorMessage(e) });
  }
}

/**
 * org 단위 행위(멤버 추가·역할 변경·삭제). `project_id` 는 null 로 둔다 —
 * 멤버는 프로젝트가 아니라 org 에 속하고, 조회는 "이 org 의 프로젝트 행 + org 전역 행"을 함께 본다.
 */
export async function recordOrgAudit(params: {
  orgId: string;
  actor: AuthContext | null;
  action: string;
  targetId?: string | null;
  diff?: AuditDiff | null;
  req?: Request;
}): Promise<void> {
  await recordAudit({
    projectId: null,
    orgId: params.orgId,
    actor: params.actor,
    action: params.action,
    targetType: "member",
    targetId: params.targetId,
    diff: params.diff,
    req: params.req,
  });
}

/**
 * 인가 거부를 기록하고 그대로 실패 응답을 돌려준다 — 호출부는 기존 `return fail(...)` 한 줄만 바꾼다.
 *
 * **401 은 적지 않는다.** 로그인하지 않은 요청까지 적으면 누구나 감사 테이블에 행을 밀어 넣을 수
 * 있어(인증 없는 쓰기) 감사 로그 자체가 증폭 공격 대상이 된다. 의미가 있는 것은
 * "로그인은 했는데 권한이 없어 막힌" 403 이다.
 */
export async function failAudited(
  req: Request,
  projectId: string,
  action: string,
  targetType: AuditTargetType,
  authz: { status: number; error: string },
  targetId?: string | null
) {
  if (authz.status === 403) {
    const actor = await getAuthContext(req);
    if (actor) {
      await recordAudit({
        projectId,
        actor,
        req,
        action: `${action}${DENIED_SUFFIX}`,
        targetType,
        targetId,
        diff: { outcome: { before: "allowed", after: `denied (${authz.error})` } },
      });
    }
  }
  return fail(authz.error, authz.status);
}

/** 가져오기 배치 id. 되돌리기는 이 값 하나로 그 회차에 들어간 행만 찾는다. */
export function newBatchId(): string {
  return crypto.randomUUID();
}

/**
 * `?from=`/`?to=` — 날짜(YYYY-MM-DD)와 ISO 를 모두 받는다. 날짜만 오면 `?tz_offset=`
 * (JS `getTimezoneOffset()` 부호, 분 단위) 기준의 그 날 00:00 으로 환산한다.
 *
 * 서버 로컬(대개 UTC)로 해석하면 서울에서 9월 11일을 고른 사람에게 9/11 09:00~9/12 09:00 이
 * 나간다 — 화면에 보이는 목록과 내려받은 CSV 의 범위가 달라진다.
 *
 * (logs 라우트의 같은 이름 함수와 규칙이 같다. 그쪽은 이 작업의 소유가 아니라 공유하지 못했다.)
 */
export function parseDateRange(url: URL): { from: Date | null; to: Date | null } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const rawOffset = Number(url.searchParams.get("tz_offset"));
  const offsetMin = Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 900 ? rawOffset : 0;
  const read = (key: string, endExclusive: boolean): Date | null => {
    const raw = url.searchParams.get(key);
    if (!raw) return null;
    if (!dateOnly.test(raw)) {
      const d = new Date(raw);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const [y, m, day] = raw.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, day + (endExclusive ? 1 : 0)) + offsetMin * 60_000);
  };
  return { from: read("from", false), to: read("to", true) };
}

export type AuditFilters = {
  action: AuditAction | null;
  actor: string | null;
  from: Date | null;
  to: Date | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 목록과 CSV 내보내기가 **같은 함수**로 조건을 만든다.
 * 따로 파싱하면 화면에 건 필터와 내려받은 파일의 범위가 조용히 어긋난다 — 감사 자료로선 치명적이다.
 */
export function parseAuditFilters(url: URL): AuditFilters {
  const actionParam = url.searchParams.get("action");
  // 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
  const action = (AUDIT_ACTIONS as readonly string[]).includes(actionParam ?? "")
    ? (actionParam as AuditAction)
    : null;
  const actor = url.searchParams.get("actor")?.trim() || null;
  const { from, to } = parseDateRange(url);
  return { action, actor, from, to };
}

/**
 * 필터 → where 조건 목록.
 *
 * 프로젝트 행과 **org 전역 행(project_id is null)** 을 함께 본다. 멤버 추가·역할 변경은
 * 프로젝트에 매이지 않는데, 그것만 빼고 보여주면 "누가 이 프로젝트에 접근하게 됐나" 를 답할 수 없다.
 * org 를 함께 걸어 타 테넌트의 전역 행이 섞이지 않게 한다.
 */
export function auditConds(projectId: string, f: AuditFilters): SQL[] {
  const conds: SQL[] = [
    sql`${auditLogs.orgId} = (select org_id from projects where id = ${projectId}::uuid)`,
    sql`(${auditLogs.projectId} = ${projectId}::uuid or ${auditLogs.projectId} is null)`,
  ];
  // 고른 action 하나로 성공과 거부를 함께 본다
  if (f.action) conds.push(sql`${auditLogs.action} in ${actionFilter(f.action)}`);
  if (f.actor) {
    conds.push(
      UUID_RE.test(f.actor)
        ? sql`${auditLogs.actorUserId} = ${f.actor}::uuid`
        : sql`${auditLogs.actor} = ${f.actor}`
    );
  }
  if (f.from) conds.push(sql`${auditLogs.createdAt} >= ${f.from.toISOString()}::timestamptz`);
  if (f.to) conds.push(sql`${auditLogs.createdAt} < ${f.to.toISOString()}::timestamptz`);
  return conds;
}

/** 프로젝트가 속한 org — 멤버 감사 팬아웃 대상 */
export async function orgIdOfProject(projectId: string): Promise<string | null> {
  const row = (await getDb().select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  return row?.orgId ?? null;
}
