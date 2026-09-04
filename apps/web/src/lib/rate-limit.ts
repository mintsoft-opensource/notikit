/**
 * 경량 인메모리 rate limiter (고정 윈도우).
 * ⚠️ 단일 인스턴스 기준 — 다중 인스턴스/프로덕션은 REDIS_URL 기반 리미터로 교체(인터페이스 동일).
 */
type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export function rateLimit(key: string, limit = 120, windowMs = 60_000): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

export function clientKey(req: Request, projectId: string): string {
  // EB/프록시 뒤 실제 클라 IP
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return `${projectId}:${ip}`;
}
