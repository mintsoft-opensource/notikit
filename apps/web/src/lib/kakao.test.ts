import { describe, it, expect, vi } from "vitest";
import { isTransientAlimtalkFailure, parseKakaoConfig, sendAlimtalk } from "./kakao";

const CONFIG = { provider_url: "https://bsp.example.com/send", api_key: "K", sender_key: "S" };
const NO_WAIT = { retryDelayMs: 0 };

describe("kakao", () => {
  it("parseKakaoConfig validates required fields", () => {
    expect(() => parseKakaoConfig({ foo: "bar" })).toThrow();
    const c = parseKakaoConfig({ provider_url: "https://bsp.example.com/send", api_key: "k", sender_key: "s" });
    expect(c.sender_key).toBe("s");
  });

  it("sendAlimtalk posts to provider with auth + payload", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const r = await sendAlimtalk(
      { provider_url: "https://bsp.example.com/send", api_key: "K", sender_key: "S" },
      "01012345678",
      "안녕\n본문",
      fetchImpl
    );
    expect(r.ok).toBe(true);
    const [url, init] = (fetchImpl as any).mock.calls[0];
    expect(url).toBe("https://bsp.example.com/send");
    expect((init.headers as any).authorization).toBe("Bearer K");
    expect(JSON.parse(init.body)).toMatchObject({ senderKey: "S", to: "01012345678" });
  });

  it("sendAlimtalk returns not-ok on network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("net");
    }) as unknown as typeof fetch;
    const r = await sendAlimtalk({ provider_url: "https://x/y", api_key: "K", sender_key: "S" }, "010", "t", fetchImpl, NO_WAIT);
    expect(r.ok).toBe(false);
  });

  it("classifies only transient statuses as retryable", () => {
    expect([0, 429, 500, 503].map(isTransientAlimtalkFailure)).toEqual([true, true, true, true]);
    expect([400, 401, 404, 422].map(isTransientAlimtalkFailure)).toEqual([false, false, false, false]);
  });

  it("sendAlimtalk retries a transient failure exactly once", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => new Response("{}", { status: ++calls === 1 ? 503 : 200 })) as unknown as typeof fetch;
    const r = await sendAlimtalk(CONFIG, "010", "t", fetchImpl, NO_WAIT);
    expect(r).toMatchObject({ ok: true, attempts: 2 });
  });

  it("sendAlimtalk stops after one retry", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const r = await sendAlimtalk(CONFIG, "010", "t", fetchImpl, NO_WAIT);
    expect(r).toMatchObject({ ok: false, attempts: 2 });
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(2);
  });

  it("sendAlimtalk does not retry a rejected payload", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    const r = await sendAlimtalk(CONFIG, "010", "t", fetchImpl, NO_WAIT);
    expect(r).toMatchObject({ ok: false, status: 400, attempts: 1 });
  });
});
