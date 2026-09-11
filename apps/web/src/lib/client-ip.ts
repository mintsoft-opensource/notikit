/**
 * 요청의 클라이언트 IP 판별 + 마스킹.
 *
 * `x-forwarded-for` 는 **클라이언트가 임의로 붙일 수 있다.** 프록시가 덮어쓰도록
 * 구성돼 있을 때만 신뢰할 수 있으므로, 신뢰할 프록시 홉 수를 운영자가 명시해야만
 * 값을 읽는다. 미설정이면 아예 읽지 않는다 — 잘못 설정된 상태에서 위조된 국가를
 * 기록하느니 국가를 비워두는 편이 낫다.
 *
 *   TRUSTED_PROXY_HOPS=0  (기본) 프록시 없음 → IP 판별 안 함
 *   TRUSTED_PROXY_HOPS=1  nginx/ALB 한 대 뒤
 *   TRUSTED_PROXY_HOPS=2  CDN + 프록시
 */

/** XFF 목록에서 신뢰 홉 수만큼 뒤에서 떨어진 값이 진짜 클라이언트다. */
function fromForwardedFor(header: string, hops: number): string | null {
  const chain = header
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (chain.length === 0) return null;

  // 체인이 신뢰 홉보다 짧으면 앞쪽이 위조된 것이다 — 가장 왼쪽을 믿으면 안 된다.
  const idx = chain.length - 1 - hops;
  return idx >= 0 ? chain[idx] : null;
}

function trustedHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS;
  const n = raw ? Number(raw) : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** IPv6 표기에 섞인 포트·대괄호·IPv4-mapped 접두사를 벗긴다. */
function normalize(raw: string): string | null {
  let ip = raw.trim();
  if (ip.startsWith("[")) ip = ip.slice(1, ip.indexOf("]") >= 0 ? ip.indexOf("]") : undefined);
  // IPv4-mapped 를 **먼저** 벗긴다. 아래 host:port 규칙보다 뒤에 두면
  // "::ffff:203.0.113.5" 가 첫 콜론에서 잘려 빈 문자열이 된다.
  if (/^::ffff:/i.test(ip) && ip.includes(".")) ip = ip.slice(7);
  // IPv4 는 host:port 로 올 수 있다. 콜론이 정확히 하나일 때만 포트로 본다 —
  // IPv6 는 콜론이 여러 개라 이 규칙에 걸리면 안 된다.
  if (ip.includes(".") && ip.split(":").length === 2) ip = ip.slice(0, ip.indexOf(":"));
  return ip || null;
}

export type ClientIp = { ip: string; family: 4 | 6 };

/**
 * 신뢰 설정이 있을 때만 클라이언트 IP를 돌려준다. 없으면 null.
 */
export function clientIp(req: Request): ClientIp | null {
  const hops = trustedHops();
  if (hops === 0) return null;

  const xff = req.headers.get("x-forwarded-for");
  if (!xff) return null;

  const raw = fromForwardedFor(xff, hops - 1);
  if (!raw) return null;

  const ip = normalize(raw);
  if (!ip) return null;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((o) => Number(o) <= 255) ? { ip, family: 4 } : null;
  }
  // 최소한의 형태 검사. 정밀 검증은 Postgres 의 inet 캐스팅에 맡긴다.
  return /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(":") ? { ip, family: 6 } : null;
}

/**
 * 저장용 마스킹 — IPv4 는 하위 1옥텟, IPv6 는 하위 80비트를 버린다(/24, /48).
 *
 * 원본 IP 는 개인정보다. 국가 판정은 마스킹 **전** 값으로 하고, 남기는 것은 이 값만
 * 둔다. /24 는 같은 사람인지 대략 구분할 수 있으면서 개인 식별력은 크게 낮춘다.
 */
export function maskIp({ ip, family }: ClientIp): string | null {
  if (family === 4) {
    const o = ip.split(".");
    return `${o[0]}.${o[1]}.${o[2]}.0`;
  }
  // IPv6 를 그룹 단위로 다루려면 :: 축약을 먼저 펴야 한다.
  const parts = expandIpv6(ip);
  // **원본으로 폴백하지 않는다.** 마스킹에 실패하면 저장하지 않는 것이 맞다 —
  // 되돌려주면 마스킹되지 않은 주소가 그대로 적재돼 "마스킹된 값만 남긴다"는
  // 이 함수의 약속이 조용히 깨진다.
  return parts ? `${parts.slice(0, 3).join(":")}::` : null;
}

/** `::` 축약을 8그룹으로 편다. 형식이 어긋나면 null. */
function expandIpv6(ip: string): string[] | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // 빈 그룹은 `::` 축약 지점에서만 나올 수 있다. 여기에 남아 있다면 ":::" 같은
  // 오타라 거부한다 — 통과시키면 빈 문자열이 그룹인 척 결과에 섞인다.
  if ([...head, ...tail].some((g) => g === "" || g.length > 4)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array(fill).fill("0"), ...tail];
}
