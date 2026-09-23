/**
 * 고정 윈도우 rate limiter.
 *
 * `REDIS_URL` 이 있으면 인스턴스끼리 카운터를 공유하고, 없으면 지금까지처럼 인메모리로만 센다
 * (프로세스당 1회 경고). 판정 로직(decideFixedWindow)은 전송 수단과 분리되어 있어 단위 테스트 대상이다.
 *
 * 공유 방식: 판정은 로컬 버킷으로 즉시 내리고(호출부가 동기 API), 같은 틱에 Redis INCR 을 보낸다.
 * 응답이 오면 로컬 카운트를 **권위 있는 값으로 끌어올린다**. 즉 인스턴스가 여러 대여도 한 왕복 안에
 * 전역 카운트로 수렴한다. Redis 가 죽으면 그냥 인메모리 리미터로 남는다(요청은 막지 않는다).
 */
import { isRedisEnabled, redisIncrementWindow } from "@/lib/redis";

export type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let calls = 0;

// 리미터 저장 상한 (키 회전 공격으로 인한 메모리 증가 방지)
const MAX_BUCKETS = 10_000;
/** 공유 키 접두사 — 한 Redis 를 다른 용도와 같이 쓰더라도 충돌하지 않게 */
const SHARED_PREFIX = "nk:rl";
/** 창이 끝난 뒤 키가 남지 않게, TTL 은 창 길이 + 약간의 여유 */
const SHARED_TTL_SLACK_MS = 5_000;

/** 주기적 만료 버킷 제거 (무한 증가 방지) */
function sweep(now: number) {
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}

/**
 * 창의 종료 시각.
 * - 로컬 전용: 첫 요청 시각 + window (지금까지의 동작 그대로)
 * - 공유 모드: epoch 정렬 — 인스턴스마다 창 시작이 달라지면 같은 Redis 키를 두고 판정이 엇갈린다
 */
export function windowResetAt(now: number, windowMs: number, alignToEpoch: boolean): number {
  return alignToEpoch ? (Math.floor(now / windowMs) + 1) * windowMs : now + windowMs;
}

/** 공유 카운터 키 — 창 번호를 키에 넣어 만료를 Redis TTL 에 맡긴다(스윕 불필요) */
export function sharedWindowKey(key: string, now: number, windowMs: number): string {
  return `${SHARED_PREFIX}:${key}:${Math.floor(now / windowMs)}`;
}

/** 순수 판정 — 저장소/전송 없음. 이전 버킷을 변형하지 않고 새 버킷을 돌려준다. */
export function decideFixedWindow(
  prev: Bucket | undefined,
  now: number,
  limit: number,
  windowMs: number,
  alignToEpoch = false
): { allowed: boolean; bucket: Bucket } {
  if (!prev || now > prev.resetAt) {
    return { allowed: true, bucket: { count: 1, resetAt: windowResetAt(now, windowMs, alignToEpoch) } };
  }
  if (prev.count >= limit) return { allowed: false, bucket: prev };
  return { allowed: true, bucket: { count: prev.count + 1, resetAt: prev.resetAt } };
}

let memoryOnlyWarned = false;

function warnMemoryOnlyOnce(): void {
  if (memoryOnlyWarned || process.env.NODE_ENV === "test") return;
  memoryOnlyWarned = true;
  console.warn(
    "[notikit] REDIS_URL is not set — rate limits are counted per instance (in-memory). " +
      "Set REDIS_URL to share limits across replicas."
  );
}

/** 신규 키인데 저장소가 가득 → 가장 오래된 항목 축출(Map 은 삽입 순서 보존). */
function evictIfFull(key: string): void {
  if (buckets.has(key) || buckets.size < MAX_BUCKETS) return;
  const oldest = buckets.keys().next().value;
  if (oldest !== undefined) buckets.delete(oldest);
}

/** Redis 카운터를 올리고, 돌아온 전역 카운트를 로컬 버킷에 반영한다(같은 창일 때만). */
function publishShared(key: string, bucket: Bucket, now: number, windowMs: number): void {
  void redisIncrementWindow(sharedWindowKey(key, now, windowMs), windowMs + SHARED_TTL_SLACK_MS).then((shared) => {
    if (shared === null) return;
    const current = buckets.get(key);
    if (!current || current.resetAt !== bucket.resetAt) return; // 창이 바뀌었으면 버린다
    if (shared > current.count) buckets.set(key, { ...current, count: shared });
  });
}

export function rateLimit(key: string, limit = 600, windowMs = 60_000): boolean {
  const now = Date.now();
  if (++calls % 2000 === 0) sweep(now);

  const shared = isRedisEnabled();
  if (!shared) warnMemoryOnlyOnce();

  const prev = buckets.get(key);
  const { allowed, bucket } = decideFixedWindow(prev, now, limit, windowMs, shared);
  if (!allowed) return false;

  evictIfFull(key);
  buckets.set(key, bucket);
  if (shared) publishShared(key, bucket, now, windowMs);
  return true;
}

/** 테스트용 — 프로세스 전역 버킷 초기화 */
export function resetRateLimits(): void {
  buckets.clear();
  calls = 0;
}

// ── 동시 처리 상한 (in-flight) — DB/해싱 이전에 admission 제어 ──
const inflight = new Map<string, number>();

/** key 의 동시 처리 수가 max 미만이면 슬롯 획득(true). 초과 시 false. */
export function acquireInflight(key: string, max: number): boolean {
  const n = inflight.get(key) ?? 0;
  if (n >= max) return false;
  inflight.set(key, n + 1);
  return true;
}

export function releaseInflight(key: string): void {
  const n = inflight.get(key) ?? 0;
  if (n <= 1) inflight.delete(key);
  else inflight.set(key, n - 1);
}

/**
 * rate limit 키 = **인증된 projectId** + 라우트 스코프(스푸핑 불가).
 * client IP(x-forwarded-for)는 위조 가능하므로 신뢰 앵커로 쓰지 않는다.
 * 프로덕션에서 per-IP 세분화가 필요하면 신뢰 프록시 뒤에서만 IP 를 추가한다.
 *
 * scope 를 반드시 나눈다. 하나의 버킷을 v1 라우트 전체가 공유하면
 * (a) 공개 api-key 만 가진 쪽이 한 라우트를 두드려 그 테넌트의 **발송 API 까지** 막을 수 있고,
 * (b) 대형 발송 직후 몰리는 클릭이 한도에 걸려 클릭률이 조직적으로 과소집계된다.
 */
export function clientKey(projectId: string, scope = "default"): string {
  return `proj:${projectId}:${scope}`;
}
