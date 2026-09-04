import { describe, it, expect, vi } from "vitest";
import { parseKakaoConfig, sendAlimtalk } from "./kakao";

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
    const r = await sendAlimtalk({ provider_url: "https://x/y", api_key: "K", sender_key: "S" }, "010", "t", fetchImpl);
    expect(r.ok).toBe(false);
  });
});
