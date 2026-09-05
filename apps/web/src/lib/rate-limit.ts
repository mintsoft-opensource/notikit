/**
 * 경량 인메모리 rate limiter (고정 윈도우).
 * ⚠️ 단일 인스턴스 기준 — 다중 인스턴스/프로덕션은 REDIS_URL 기반 리미터로 교체(인터페이스 동일).
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();
let calls = 0;

// 리미터 저장 상한 (키 회전 공격으로 인한 메모리 증가 방지)
const MAX_BUCKETS = 10_000;

/** 주기적 만료 버킷 제거 (무한 증가 방지) */
function sweep(now: number) {
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}

export function rateLimit(key: string, limit = 600, windowMs = 60_000): boolean {
  const now = Date.now();
  if (++calls % 2000 === 0) sweep(now);
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    // 신규 키인데 저장소가 가득 → sweep 후에도 가득이면 거부 (카디널리티 상한)
    if (!buckets.has(key) && buckets.size >= MAX_BUCKETS) {
      sweep(now);
      if (buckets.size >= MAX_BUCKETS) return false;
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
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
 * rate limit 키 = **인증된 projectId**(스푸핑 불가).
 * client IP(x-forwarded-for)는 위조 가능하므로 신뢰 앵커로 쓰지 않는다.
 * 프로덕션에서 per-IP 세분화가 필요하면 신뢰 프록시 뒤에서만 IP 를 추가하고 Redis 리미터로 교체.
 */
export function clientKey(projectId: string): string {
  return `proj:${projectId}`;
}
