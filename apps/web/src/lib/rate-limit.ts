/**
 * 고정 윈도우 rate limiter.
 *
 * 두 가지 입구가 있다.
 *
 * - `rateLimitShared()` — **권위 있는 판정**. Redis 가 있으면 INCR 결과를 (예산 안에서) 기다려
 *   전역 카운트로 판정한다. replica 가 몇 대든 한도는 하나다. Redis 가 진짜로 안 될 때만
 *   로컬 계수로 떨어진다(요청은 막지 않는다 — Redis 가 죽었다고 발송 API 가 죽으면 안 된다).
 * - `rateLimit()` — 동기 입구(레거시). 판정을 기다릴 수 없어 로컬 버킷으로 즉시 내리고,
 *   Redis 응답이 오면 로컬 카운트를 권위 있는 값으로 끌어올린다. 한 왕복만큼 늦게 수렴하므로
 *   **버스트 구간에서는 replica 배수만큼 느슨하다**. 새 호출부는 쓰지 말 것.
 *
 * 판정 로직(decideFixedWindow)은 전송 수단과 분리되어 있어 단위 테스트 대상이다.
 */
import { createHash } from "node:crypto";
import { getRedisHealth, isRedisEnabled, redisIncrementWindow, type RedisHealth } from "@/lib/redis";

export type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let calls = 0;

// 리미터 저장 상한 (키 회전 공격으로 인한 메모리 증가 방지)
const MAX_BUCKETS = 10_000;
/** 공유 키 접두사 — 한 Redis 를 다른 용도와 같이 쓰더라도 충돌하지 않게 */
const SHARED_PREFIX = "nk:rl";
/** 창이 끝난 뒤 키가 남지 않게, TTL 은 창 길이 + 약간의 여유 */
const SHARED_TTL_SLACK_MS = 5_000;
/**
 * 권위 있는 판정을 위해 요청이 Redis 를 기다리는 상한.
 * 여기서 더 늘리면 Redis 지연이 그대로 API 응답 지연이 되고, 더 줄이면 평상시에도 폴백한다.
 */
const SHARED_WAIT_MS = 200;

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

/** 로컬 버킷만으로 내리는 판정 — Redis 가 없거나 응답이 예산을 넘겼을 때의 경로. */
function decideLocal(key: string, now: number, limit: number, windowMs: number, alignToEpoch: boolean): boolean {
  const { allowed, bucket } = decideFixedWindow(buckets.get(key), now, limit, windowMs, alignToEpoch);
  if (!allowed) return false;
  evictIfFull(key);
  buckets.set(key, bucket);
  return true;
}

/**
 * **권위 있는 한도.** Redis 가 있으면 INCR 결과를 기다려 전역 카운트로 판정한다
 * (예산 SHARED_WAIT_MS). 거절된 요청도 카운트를 소비한다 — 고정창 INCR 리미터의 표준 동작이고,
 * 거절을 공짜로 만들면 한도를 넘긴 쪽이 계속 두드릴 수 있다.
 *
 * Redis 가 없거나 예산 안에 답이 없으면 로컬 버킷으로 떨어진다. 이때 버킷에는 직전에 받아 둔
 * 전역 카운트가 남아 있으므로, 폴백은 0 부터가 아니라 마지막으로 알던 값에서 이어 센다.
 */
export async function rateLimitShared(key: string, limit = 600, windowMs = 60_000): Promise<boolean> {
  const now = Date.now();
  if (++calls % 2000 === 0) sweep(now);

  if (!isRedisEnabled()) {
    warnMemoryOnlyOnce();
    return decideLocal(key, now, limit, windowMs, false);
  }

  const shared = await redisIncrementWindow(
    sharedWindowKey(key, now, windowMs),
    windowMs + SHARED_TTL_SLACK_MS,
    SHARED_WAIT_MS
  );
  // redis.ts 가 폴백 횟수를 세고 경고를 찍는다 — 여기서는 판정만 이어 간다
  if (shared === null) return decideLocal(key, now, limit, windowMs, true);

  evictIfFull(key);
  buckets.set(key, { count: shared, resetAt: windowResetAt(now, windowMs, true) });
  return shared <= limit;
}

/**
 * 동기 입구(레거시). 판정을 기다릴 수 없으므로 로컬 버킷으로 즉시 내리고, 같은 틱에 보낸
 * Redis INCR 의 응답으로 로컬 카운트를 끌어올린다 — 한 왕복 뒤부터 전역 카운트로 수렴한다.
 *
 * 즉 **버스트의 첫 왕복 동안은 replica 수만큼 느슨하다**. 공개 엔드포인트처럼 한도가
 * 실제로 지켜져야 하는 곳은 `rateLimitShared()` 를 쓴다.
 */
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

/** 한도가 실제로 공유되고 있는지(= 인메모리로 떨어지고 있지 않은지) 운영이 읽는 지점. */
export function getRateLimitHealth(): RedisHealth & { trackedKeys: number } {
  return { ...getRedisHealth(), trackedKeys: buckets.size };
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

/**
 * 테넌트 버킷만으로는 **한 대의 기기가 그 테넌트의 모든 사용자를 429 로 만든다**.
 * 보고 계열 라우트(클릭·전환)는 프로젝트 버킷 위에 기기/사용자 차원을 하나 더 얹어,
 * 남용하는 주체만 걸리고 나머지 사용자의 보고는 계속 들어오게 한다.
 *
 * principal(푸시 토큰·user_id)은 그대로 키에 넣지 않고 해시한다 —
 * 토큰이 로그·메모리 덤프에 남지 않게 하고, 키 길이를 고정해 버킷 크기를 예측 가능하게 둔다.
 */
export function principalKey(projectId: string, scope: string, principal: string): string {
  const digest = createHash("sha256").update(principal).digest("hex").slice(0, 16);
  return `proj:${projectId}:${scope}:p:${digest}`;
}
