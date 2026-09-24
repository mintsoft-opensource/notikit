import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// undici Agent 는 소켓을 여는 물건이라 대역으로 세운다 — 여기서 보는 것은
// **몇 개가 만들어지고 몇 개가 닫히는가**(fd 누수)와 핀닝이 유지되는가다.
const undiciMock = vi.hoisted(() => {
  const created: FakeAgent[] = [];
  class FakeAgent {
    closed = false;
    constructor(public readonly opts: Record<string, unknown>) {
      created.push(this);
    }
    async close(): Promise<void> {
      this.closed = true;
    }
  }
  return { created, FakeAgent };
});

vi.mock("undici", () => ({ Agent: undiciMock.FakeAgent }));

const dnsMock = vi.hoisted(() => ({ lookup: vi.fn<(host: string, opts: unknown) => Promise<{ address: string }[]>>() }));
vi.mock("node:dns/promises", () => ({ lookup: dnsMock.lookup }));

import { closePinnedAgents, isBlockedIp, MAX_PINNED_AGENTS, safeFetch, validateAndResolve } from "./safe-fetch";

type FetchCall = { url: URL; init: Record<string, unknown> };

let calls: FetchCall[];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  undiciMock.created.length = 0;
  dnsMock.lookup.mockReset();
  calls = [];
  await closePinnedAgents();
  globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: url as URL, init: (init ?? {}) as Record<string, unknown> });
    return new Response("ok");
  }) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await closePinnedAgents();
});

describe("isBlockedIp", () => {
  it("공인 유니캐스트만 통과시킨다", () => {
    expect(isBlockedIp("93.184.216.34")).toBe(false);
    expect(isBlockedIp("2606:2800:220:1:248:1893:25c8:1946")).toBe(false);
  });

  it("루프백/사설/링크로컬/ULA/IPv4-mapped 를 막는다", () => {
    for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "not-an-ip"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });
});

describe("validateAndResolve", () => {
  it("https 가 아니거나 내부 이름이면 거절한다", async () => {
    await expect(validateAndResolve("http://example.com")).rejects.toThrow("https");
    await expect(validateAndResolve("not a url")).rejects.toThrow("invalid url");
    for (const host of ["localhost", "db.local", "svc.internal", "metadata.google.internal"]) {
      await expect(validateAndResolve(`https://${host}/x`)).rejects.toThrow("not allowed");
    }
  });

  it("사설 IP 로 풀리는 호스트는 거절한다 — 한 레코드만 사설이어도 막는다", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "93.184.216.34" }, { address: "127.0.0.1" }]);
    await expect(validateAndResolve("https://rebind.example/x")).rejects.toThrow("non-public");
  });

  it("공인 호스트는 확정된 IP 를 돌려준다(핀닝 대상)", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    await expect(validateAndResolve("https://example.com/x")).resolves.toMatchObject({ pinnedIp: "93.184.216.34" });
  });
});

describe("safeFetch — SSRF 보호", () => {
  it("리다이렉트를 금지하고 확정 IP 로 연결을 핀닝한다", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    await safeFetch("https://example.com/hook", { method: "POST" });

    expect(calls[0].url.toString()).toBe("https://example.com/hook");
    expect(calls[0].init.redirect).toBe("error");
    expect(calls[0].init.method).toBe("POST");

    // Agent 의 lookup 은 hostname 과 무관하게 검증된 IP 만 돌려준다
    const connect = undiciMock.created[0].opts.connect as {
      lookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void;
    };
    const cb = vi.fn();
    connect.lookup("example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "93.184.216.34", 4);
  });

  it("IPv6 핀닝은 family 6 으로 넘긴다", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "2606:2800:220:1:248:1893:25c8:1946" }]);
    await safeFetch("https://v6.example.com/x");
    const connect = undiciMock.created[0].opts.connect as {
      lookup: (h: string, o: unknown, cb: (e: null, a: string, f: number) => void) => void;
    };
    const cb = vi.fn();
    connect.lookup("v6.example.com", {}, cb);
    expect(cb).toHaveBeenCalledWith(null, "2606:2800:220:1:248:1893:25c8:1946", 6);
  });

  it("차단 대상은 fetch 까지 가지 않는다", async () => {
    await expect(safeFetch("https://127.0.0.1/x")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

// 누수 재현 지점: 예전 구현은 호출마다 new Agent 를 만들고 아무도 닫지 않았다.
describe("safeFetch — dispatcher 재사용 (fd 누수)", () => {
  it("웹훅 스윕 200건이 Agent 를 200개 만들지 않는다", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    for (let i = 0; i < 200; i++) await safeFetch(`https://example.com/hook/${i}`);

    expect(undiciMock.created).toHaveLength(1);
    // 200건 모두 같은 dispatcher 를 썼다
    expect(new Set(calls.map((c) => c.init.dispatcher)).size).toBe(1);
  });

  it("대상이 많아도 열린 풀 수가 상한을 넘지 않고, 밀려난 것은 닫힌다", async () => {
    for (let i = 0; i < MAX_PINNED_AGENTS + 10; i++) {
      dnsMock.lookup.mockResolvedValueOnce([{ address: `93.184.${Math.floor(i / 256)}.${i % 256}` }]);
      await safeFetch(`https://h${i}.example.com/x`);
    }

    expect(undiciMock.created).toHaveLength(MAX_PINNED_AGENTS + 10);
    const open = undiciMock.created.filter((a) => !a.closed);
    expect(open).toHaveLength(MAX_PINNED_AGENTS); // 열린 소켓 풀은 상한에 묶인다
    // 가장 오래 안 쓴 것부터 닫힌다
    expect(undiciMock.created.slice(0, 10).every((a) => a.closed)).toBe(true);
  });

  it("대상 IP 가 다르면 풀을 나눈다 — 재사용이 핀닝을 우회하지 않는다", async () => {
    dnsMock.lookup.mockResolvedValueOnce([{ address: "93.184.216.34" }]);
    await safeFetch("https://example.com/x");
    dnsMock.lookup.mockResolvedValueOnce([{ address: "93.184.216.35" }]);
    await safeFetch("https://example.com/x");

    expect(undiciMock.created).toHaveLength(2);
    expect(calls[0].init.dispatcher).not.toBe(calls[1].init.dispatcher);
  });

  it("closePinnedAgents 는 남은 풀을 모두 닫는다", async () => {
    dnsMock.lookup.mockResolvedValue([{ address: "93.184.216.34" }]);
    await safeFetch("https://example.com/x");
    await closePinnedAgents();
    expect(undiciMock.created.every((a) => a.closed)).toBe(true);
  });
});
