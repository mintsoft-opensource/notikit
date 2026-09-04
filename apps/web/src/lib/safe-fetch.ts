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
 * SSRF-안전 fetch — 검증 후 확정된 IP 로 연결을 **핀닝**(DNS rebinding/TOCTOU 방지),
 * TLS SNI/인증서 검증은 원 hostname 유지. 리다이렉트 금지.
 */
export async function safeFetch(raw: string, init: RequestInit = {}): Promise<Response> {
  const { url, pinnedIp } = await validateAndResolve(raw);
  const dispatcher = pinnedIp
    ? new Agent({
        connect: {
          lookup: (_hostname, _opts, cb: (err: NodeJS.ErrnoException | null, address: string, family: number) => void) =>
            cb(null, pinnedIp, pinnedIp.includes(":") ? 6 : 4),
        },
      })
    : undefined;
  return fetch(url, { ...init, redirect: "error", ...(dispatcher ? { dispatcher } : {}) } as RequestInit);
}
