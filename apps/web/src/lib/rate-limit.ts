/**
 * 고정 윈도우 rate limiter.
 *
 * 입구는 `rateLimitShared()` 하나다 — **권위 있는 판정**. Redis 가 있으면 INCR 결과를
 * (예산 안에서) 기다려 전역 카운트로 판정한다. replica 가 몇 대든 한도는 하나다.
 * Redis 가 진짜로 안 될 때만 로컬 계수로 떨어진다(요청은 막지 않는다 — Redis 가 죽었다고
 * 발송 API 가 죽으면 안 된다).
 *
 * 예전에는 동기 입구 `rateLimit()` 도 있었다. 판정을 기다리지 못해 버스트의 첫 왕복 동안
 * replica 배수만큼 느슨했고, 마지막 호출부가 `rateLimitShared()` 로 옮겨 간 뒤로는
 * 테스트만 그것을 부르고 있었다(= 가짜 커버리지). 지웠다.
 *
 * 창은 언제나 **epoch 정렬**이다. 인스턴스마다 창 시작이 다르면 같은 Redis 키를 두고
 * 판정이 엇갈리고, Redis 가 빠졌다 돌아올 때 로컬 창과 공유 창이 어긋난다.
 *
 * 판정 로직(decideFixedWindow)은 전송 수단과 분리되어 있어 단위 테스트 대상이다.
 */
import { createHash } from "node:crypto";
import { logThrottled } from "@/lib/logger";
import { getRedisHealth, isRedisEnabled, redisIncrementWindow, type RedisHealth } from "@/lib/redis";

export type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let calls = 0;

// 리미터 저장 상한 (키 회전 공격으로 인한 메모리 증가 방지)
export const MAX_BUCKETS = 10_000;
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
 * 창의 종료 시각 — epoch 정렬. 인스턴스마다 창 시작이 달라지면 같은 Redis 키를 두고
 * 판정이 엇갈리고, 폴백으로 오갈 때 로컬 창과 공유 창의 경계가 어긋난다.
 */
export function windowResetAt(now: number, windowMs: number): number {
  return (Math.floor(now / windowMs) + 1) * windowMs;
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
  windowMs: number
): { allowed: boolean; bucket: Bucket } {
  if (!prev || now > prev.resetAt) {
    return { allowed: true, bucket: { count: 1, resetAt: windowResetAt(now, windowMs) } };
  }
  if (prev.count >= limit) return { allowed: false, bucket: prev };
  return { allowed: true, bucket: { count: prev.count + 1, resetAt: prev.resetAt } };
}

/** REDIS_URL 이 없으면 한도는 인스턴스마다 따로 센다 — 조용히 넘기지 않는다. */
function warnMemoryOnly(): void {
  logThrottled("warn", "ratelimit.memory_only", { reason: "REDIS_URL is not set" }, 10 * 60_000);
}

/**
 * 접근 표시 — 만진 버킷을 Map 의 맨 뒤로 보낸다(삽입 순서를 LRU 순서로 쓴다).
 *
 * `set` 만으로는 부족하다: 이미 있는 키에 `set` 해도 Map 은 순서를 갱신하지 않으므로,
 * 계속 쓰이는 버킷이 영원히 "가장 오래된" 자리에 남는다. 지운 뒤 다시 넣어야 갱신된다.
 */
function touch(key: string, bucket: Bucket): void {
  buckets.delete(key);
  buckets.set(key, bucket);
}

/**
 * 신규 키인데 저장소가 가득 → **가장 오래 쓰이지 않은(LRU)** 항목 축출.
 *
 * 삽입 순서로 버리면 안 된다. 프로젝트 한도(20_000/분)가 MAX_BUCKETS 보다 크므로
 * 공개 api-key 만 쥔 쪽이 매 요청 새 token 을 보내면 한도를 채우기 전에 저장소가 먼저
 * 가득 찬다. 이때 삽입 순서 축출은 가장 먼저 만들어져 계속 갱신되던 `proj:<id>:*`
 * 버킷부터 버리고, 카운트가 1 부터 다시 시작해 **한도가 통째로 무력화된다**
 * (측정: 한도 20_000 에 60_000 요청 전부 통과). 덤으로 남의 테넌트 버킷까지 날아간다.
 *
 * 그래서 기준은 마지막 **접근** 시각이다. 활성 버킷은 매 요청 touch 되어 맨 뒤에 있고,
 * 밀려나는 것은 한 번 쓰이고 버려진 유휴 버킷뿐이다.
 */
function evictIfFull(key: string): void {
  if (buckets.has(key) || buckets.size < MAX_BUCKETS) return;
  const lru = buckets.keys().next().value;
  if (lru !== undefined) buckets.delete(lru);
}

/** 로컬 버킷만으로 내리는 판정 — Redis 가 없거나 응답이 예산을 넘겼을 때의 경로. */
function decideLocal(key: string, now: number, limit: number, windowMs: number): boolean {
  const { allowed, bucket } = decideFixedWindow(buckets.get(key), now, limit, windowMs);
  // 거절도 접근이다 — 만지지 않으면 **한도에 걸린 버킷이 가장 먼저 축출되어** 한도가 풀린다
  if (!allowed) {
    touch(key, bucket);
    return false;
  }
  evictIfFull(key);
  touch(key, bucket);
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
    warnMemoryOnly();
    return decideLocal(key, now, limit, windowMs);
  }

  const shared = await redisIncrementWindow(
    sharedWindowKey(key, now, windowMs),
    windowMs + SHARED_TTL_SLACK_MS,
    SHARED_WAIT_MS
  );
  // redis.ts 가 폴백 횟수를 세고 경고를 찍는다 — 여기서는 판정만 이어 간다
  if (shared === null) return decideLocal(key, now, limit, windowMs);

  evictIfFull(key);
  touch(key, { count: shared, resetAt: windowResetAt(now, windowMs) });
  return shared <= limit;
}

/** 테스트용 — 프로세스 전역 버킷 초기화 */
export function resetRateLimits(): void {
  buckets.clear();
  calls = 0;
}

/**
 * 한도가 실제로 공유되고 있는지(= 인메모리로 떨어지고 있지 않은지) 운영이 읽는 지점.
 * **프로세스 단위 값이다** — replica 가 여럿이면 이 숫자는 그 인스턴스의 조각이다.
 */
export function getRateLimitHealth(): RedisHealth & { scope: "process"; trackedKeys: number } {
  return { ...getRedisHealth(), scope: "process", trackedKeys: buckets.size };
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
