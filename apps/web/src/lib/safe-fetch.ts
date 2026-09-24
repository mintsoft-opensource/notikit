import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

/** 공인 유니캐스트 IP 만 허용 — 루프백/사설/링크로컬/ULA/예약/IPv4-mapped 전부 차단 */
export function isBlockedIp(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) addr = v6.toIPv4Address();
  }
  return addr.range() !== "unicast";
}

/** URL 검증 + 안전한 대상 IP 확정(핀닝용). DNS 실패/사설 대상이면 throw. */
export async function validateAndResolve(raw: string): Promise<{ url: URL; pinnedIp: string | null }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid url");
  }
  if (url.protocol !== "https:") throw new Error("url must be https");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host === "metadata.google.internal") {
    throw new Error("host not allowed");
  }
  if (ipaddr.isValid(host)) {
    if (isBlockedIp(host)) throw new Error("host not allowed (private/loopback)");
    return { url, pinnedIp: null };
  }
  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error("dns lookup failed");
  }
  if (addrs.length === 0) throw new Error("no dns records");
  for (const a of addrs) if (isBlockedIp(a.address)) throw new Error("resolves to a non-public address");
  return { url, pinnedIp: addrs[0].address };
}

/**
 * 핀닝 dispatcher 캐시 상한. 대상 IP 하나당 Agent 하나를 재사용한다.
 *
 * 호출마다 `new Agent` 를 만들면 그 Agent 의 커넥션 풀은 아무도 닫아 주지 않는다 —
 * 웹훅 스윕(60초마다 최대 200건)이 도는 워커에서는 소켓 풀이 계속 쌓여 fd 가 단조 증가한다.
 * 대상이 몇 개든 열려 있는 풀 수가 이 상한을 넘지 않게 묶고, 밀려난 Agent 는 닫는다.
 */
export const MAX_PINNED_AGENTS = 64;

/** pinnedIp → Agent. Map 의 삽입 순서를 LRU 순서로 쓴다(만질 때마다 맨 뒤로 보낸다). */
const pinnedAgents = new Map<string, Agent>();

/**
 * 이 IP 로 핀닝된 Agent — 있으면 재사용, 없으면 만들고 가장 오래 안 쓴 것을 닫는다.
 *
 * IP 별로 나누는 것이 핀닝의 핵심이다. Agent 안의 keep-alive 커넥션은 origin(host:port)
 * 별로 풀링되고 lookup 은 언제나 이 IP 만 돌려주므로, 같은 호스트라도 DNS 가 다른 IP 로
 * 바뀌면 다른 Agent(=다른 풀)를 쓰게 되어 재사용이 핀닝을 우회하지 않는다.
 */
function agentForIp(pinnedIp: string): Agent {
  const cached = pinnedAgents.get(pinnedIp);
  if (cached) {
    pinnedAgents.delete(pinnedIp);
    pinnedAgents.set(pinnedIp, cached);
    return cached;
  }

  const agent = new Agent({
    // 한 대상이 풀을 무한히 벌리지 못하게. 유휴 커넥션은 스윕 주기 안에 스스로 닫힌다.
    connections: 8,
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 30_000,
    connect: {
      lookup: (_hostname, _opts, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) =>
        cb(null, pinnedIp, pinnedIp.includes(":") ? 6 : 4),
    },
  });
  pinnedAgents.set(pinnedIp, agent);

  while (pinnedAgents.size > MAX_PINNED_AGENTS) {
    const lru = pinnedAgents.keys().next().value;
    if (lru === undefined) break;
    const victim = pinnedAgents.get(lru);
    pinnedAgents.delete(lru);
    // close() 는 진행 중인 요청이 끝난 뒤 닫는다(destroy() 와 달리 끊지 않는다)
    void victim?.close().catch(() => {});
  }
  return agent;
}

/** 테스트/graceful shutdown — 열려 있는 핀닝 풀을 모두 닫는다. */
export async function closePinnedAgents(): Promise<void> {
  const agents = [...pinnedAgents.values()];
  pinnedAgents.clear();
  await Promise.all(agents.map((a) => a.close().catch(() => {})));
}

/**
 * SSRF-안전 fetch — 검증 후 확정된 IP 로 연결을 **핀닝**(DNS rebinding/TOCTOU 방지),
 * TLS SNI/인증서 검증은 원 hostname 유지. 리다이렉트 금지.
 */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const { url, pinnedIp } = await validateAndResolve(raw);
  const dispatcher = pinnedIp ? agentForIp(pinnedIp) : undefined;
  return fetch(url, { ...init, redirect: "error", ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
}
