/**
 * 구조화 로거 + 프로세스 카운터 — 의존성 없음.
 *
 * 흩어진 `console.warn` 을 한 곳으로 모은다. 사람이 읽는 문장 대신 **한 줄 JSON** 을 찍는 이유는
 * 운영에서 이 로그를 grep·jq 로 자르기 때문이다. 문장은 문구가 바뀌는 순간 집계가 깨진다.
 *
 * 두 가지를 한 번에 한다.
 * 1. 로그 한 줄: `{"ts","level","event","instance",...fields}`
 * 2. 카운터: **레벨과 무관하게** 언제나 센다. 로그 레벨을 올려 조용하게 만들어도 카운터는 남는다.
 *    (로그를 눌러 두면 조용한 실패가 통째로 사라지던 문제 — 억제해도 수는 세어야 한다.)
 *
 * 절대 남기지 않는 것: 푸시 토큰 · 전화번호 · 이메일 · 시크릿 · 쿠키 · 서명.
 * 필드 값은 원시값만 받고(객체 금지), 키 이름이 민감 목록에 걸리면 값을 버린다.
 * "실수로 토큰이 찍히는" 경로를 호출부의 주의력이 아니라 타입과 필터로 막는다.
 */
import os from "node:os";

export type LogLevel = "debug" | "info" | "warn" | "error";
/** 필드 값은 원시값만 — 객체를 허용하면 토큰이 통째로 딸려 들어온다 */
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

const RANK: Record<LogLevel | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** 인스턴스 식별자 — 프로세스별 카운터를 replica 끼리 구분해서 읽으려고 로그에도 박는다. */
export const INSTANCE_ID = process.env.NOTIKIT_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`;

/** 값이 아니라 **키 이름**으로 거른다 — 호출부가 어떤 값을 넣든 이 키는 새지 않는다. */
const SENSITIVE_KEY = /(token|secret|password|passwd|phone|tel|mobile|email|authorization|auth|cookie|credential|api[-_]?key|signature|identity)/i;
/** 자유 텍스트(예외 메시지)가 로그 한 줄을 통째로 먹지 않게 */
const MAX_VALUE_LENGTH = 300;
/** 카운터 키 상한 — 이벤트 이름이 무한히 늘어도 메모리가 선형으로 늘지 않게 */
const MAX_COUNTER_KEYS = 200;
const MAX_REASONS_PER_EVENT = 50;
/** 같은 이벤트의 반복 경고를 묶는 기본 주기 */
export const DEFAULT_THROTTLE_MS = 60_000;

/** 기본 레벨: 테스트는 조용히, 그 밖은 info. `NOTIKIT_LOG_LEVEL` 로 덮는다(silent 포함). */
function threshold(): number {
  const raw = process.env.NOTIKIT_LOG_LEVEL?.trim().toLowerCase();
  if (raw && raw in RANK) return RANK[raw as keyof typeof RANK];
  return process.env.NODE_ENV === "test" ? RANK.silent : RANK.info;
}

function sanitize(fields: LogFields | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k)) continue; // 값은 보지도 않는다
    out[k] = typeof v === "string" && v.length > MAX_VALUE_LENGTH ? `${v.slice(0, MAX_VALUE_LENGTH)}…` : v;
  }
  return out;
}

// ── 카운터 ──
const events = new Map<string, number>();
const reasons = new Map<string, Map<string, number>>();

function bump(map: Map<string, number>, key: string, max: number, delta: number): void {
  const prev = map.get(key);
  if (prev === undefined && map.size >= max) return; // 상한을 넘은 새 키는 버린다(기존 집계는 지킨다)
  map.set(key, (prev ?? 0) + delta);
}

/**
 * 이벤트 1건을 센다. `reason` 필드가 있으면 사유별로도 쪼갠다 —
 * "실패 12건"만으로는 쿼터 문제와 죽은 토큰을 구분할 수 없다.
 */
export function countEvent(event: string, fields?: LogFields, delta = 1): void {
  bump(events, event, MAX_COUNTER_KEYS, delta);
  const reason = fields?.reason;
  if (typeof reason !== "string" || reason === "") return;
  let byReason = reasons.get(event);
  if (!byReason) {
    if (reasons.size >= MAX_COUNTER_KEYS) return;
    byReason = new Map();
    reasons.set(event, byReason);
  }
  bump(byReason, reason, MAX_REASONS_PER_EVENT, delta);
}

export type LogCounters = {
  /** 이 값들은 **프로세스 단위**다 — replica 가 여럿이면 합이 아니다(노출 지점에서 그렇게 표시한다) */
  scope: "process";
  instance: string;
  since: string;
  events: Record<string, number>;
  reasons: Record<string, Record<string, number>>;
};

let countersSince = Date.now();

export function getLogCounters(): LogCounters {
  return {
    scope: "process",
    instance: INSTANCE_ID,
    since: new Date(countersSince).toISOString(),
    events: Object.fromEntries(events),
    reasons: Object.fromEntries([...reasons].map(([e, m]) => [e, Object.fromEntries(m)])),
  };
}

export function resetLogCounters(): void {
  events.clear();
  reasons.clear();
  throttleState.clear();
  countersSince = Date.now();
}

// ── 출력 ──
/**
 * 예약 키는 **언제나 이긴다**. 호출부가 `event`(웹훅 이벤트 이름 등)를 필드로 넘기면
 * 로그의 이벤트 이름이 조용히 덮여 집계가 통째로 어긋난다 — 그래서 뒤에 붙인다.
 * 필드 쪽에서 같은 이름을 쓰고 싶으면 `webhook_event` 처럼 접두사를 붙인다.
 */
function emit(level: LogLevel, event: string, fields: Record<string, LogValue>): void {
  const line = JSON.stringify({ ...fields, ts: new Date().toISOString(), level, event, instance: INSTANCE_ID });
  // warn/error 는 stderr — 컨테이너 로그 수집기가 심각도를 스트림으로 가른다
  if (RANK[level] >= RANK.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** 이벤트 1건: 언제나 세고, 레벨이 허용하면 한 줄 찍는다. */
export function logEvent(level: LogLevel, event: string, fields?: LogFields): void {
  countEvent(event, fields);
  if (RANK[level] < threshold()) return;
  emit(level, event, sanitize(fields));
}

export const log = {
  debug: (event: string, fields?: LogFields) => logEvent("debug", event, fields),
  info: (event: string, fields?: LogFields) => logEvent("info", event, fields),
  warn: (event: string, fields?: LogFields) => logEvent("warn", event, fields),
  error: (event: string, fields?: LogFields) => logEvent("error", event, fields),
};

const throttleState = new Map<string, { last: number; suppressed: number }>();

/**
 * 같은 사연의 로그를 주기당 1회로 묶되, 그 사이 **눌린 횟수를 함께 남긴다**.
 * 프로세스당 1회만 찍으면 장애가 두 번째부터 로그에서 사라진다.
 * 억제된 건도 카운터에는 전부 남는다(`logEvent` 가 아니라 `countEvent` 를 먼저 부른다).
 */
export function logThrottled(level: LogLevel, event: string, fields?: LogFields, windowMs = DEFAULT_THROTTLE_MS): void {
  countEvent(event, fields);
  const now = Date.now();
  const prev = throttleState.get(event);
  if (prev && now - prev.last < windowMs) {
    prev.suppressed += 1;
    return;
  }
  throttleState.set(event, { last: now, suppressed: 0 });
  if (RANK[level] < threshold()) return;
  const suppressed = prev?.suppressed ?? 0;
  emit(level, event, {
    ...sanitize(fields),
    ...(suppressed > 0 ? { suppressed, suppressed_over_sec: Math.round((now - (prev?.last ?? now)) / 1000) } : {}),
  });
}

/** 예외를 로그 필드로 — 스택은 남기지 않는다(메시지에 시크릿이 실릴 수 있어 길이도 자른다). */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
