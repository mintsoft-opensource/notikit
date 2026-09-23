import { describe, it, expect, vi } from "vitest";
import { NotikitReactNative, NotikitClient, NotikitError } from "./index";

function mockFetch(response: unknown, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

const okEnvelope = (data: unknown) => ({ success: true, data, error: null });
const base = { baseUrl: "https://push.test", apiKey: "nk_test" };

function lastCall(fetch: unknown) {
  const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(String(init.body)) };
}

describe("NotikitReactNative", () => {
  it("register sends fcm token and platform without identity_hash when userId is absent", async () => {
    const fetch = mockFetch(okEnvelope({ device: { id: "d1" } }));
    const rn = new NotikitReactNative({ ...base, identityHash: "ih_1", fetch });

    const res = await rn.register("fcm_token_1", "android");

    expect(res).toEqual({ device: { id: "d1" } });
    const { url, body } = lastCall(fetch);
    expect(url).toBe("https://push.test/api/v1/devices");
    expect(body.token).toBe("fcm_token_1");
    expect(body.platform).toBe("android");
    expect(body.user_id).toBeUndefined();
    expect(body.external_id).toBeUndefined();
    expect(body.identity_hash).toBeUndefined();
  });

  it("register includes identity_hash only when userId is provided", async () => {
    const fetch = mockFetch(okEnvelope({ device: { id: "d2" } }));
    const rn = new NotikitReactNative({ ...base, identityHash: "ih_1", fetch });

    await rn.register("fcm_token_2", "ios", "user-42");

    const { body } = lastCall(fetch);
    expect(body.platform).toBe("ios");
    expect(body.user_id).toBe("user-42");
    expect(body.external_id).toBeUndefined();
    expect(body.identity_hash).toBe("ih_1");
  });

  it("does not send api-secret header (client-side SDK)", async () => {
    const fetch = mockFetch(okEnvelope({ device: { id: "d3" } }));
    const rn = new NotikitReactNative({ ...base, fetch });

    await rn.register("t", "android");

    const { init } = lastCall(fetch);
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("nk_test");
    expect(headers["api-secret"]).toBeUndefined();
  });

  it("identify passes identityHash and attributes", async () => {
    const fetch = mockFetch(okEnvelope({ user: { id: "u1" } }));
    const rn = new NotikitReactNative({ ...base, identityHash: "ih_9", fetch });

    const res = await rn.identify("user-9", { plan: "pro" });

    expect(res).toEqual({ user: { id: "u1" } });
    const { url, body } = lastCall(fetch);
    expect(url).toBe("https://push.test/api/v1/users/identify");
    expect(body.user_id).toBe("user-9");
    expect(body.external_id).toBeUndefined();
    expect(body.identity_hash).toBe("ih_9");
    expect(body.attributes).toEqual({ plan: "pro" });
  });

  it("subscribe posts topic and token", async () => {
    const fetch = mockFetch(okEnvelope({ subscribed: true, topic: "news" }));
    const rn = new NotikitReactNative({ ...base, fetch });

    const res = await rn.subscribe("news", "fcm_token_3");

    expect(res).toEqual({ subscribed: true, topic: "news" });
    const { url, body } = lastCall(fetch);
    expect(url).toBe("https://push.test/api/v1/topics/subscribe");
    expect(body).toEqual({ topic: "news", token: "fcm_token_3" });
  });

  it("unsubscribe posts topic and token to the unsubscribe endpoint", async () => {
    const fetch = mockFetch(okEnvelope({ unsubscribed: true, topic: "news", removed: 1 }));
    const rn = new NotikitReactNative({ ...base, fetch });

    const res = await rn.unsubscribe("news", "fcm_token_3");

    expect(res).toEqual({ unsubscribed: true, topic: "news", removed: 1 });
    const { url, body } = lastCall(fetch);
    // 구독과 **다른** 경로여야 한다 — 같은 경로로 보내면 끄기가 켜기가 된다
    expect(url).toBe("https://push.test/api/v1/topics/unsubscribe");
    expect(body).toEqual({ topic: "news", token: "fcm_token_3" });
  });

  it("subscribe by the deprecated externalId sends user_id, not token", async () => {
    const fetch = mockFetch(okEnvelope({ subscribed: true, topic: "vip", devices: 2, added: 2 }));
    const rn = new NotikitReactNative({ ...base, fetch });

    await rn.core.subscribe("vip", { externalId: "user-9", identityHash: "ih" });

    const { body } = lastCall(fetch);
    expect(body).toEqual({ topic: "vip", user_id: "user-9", identity_hash: "ih" });
    // 서버는 token 과 user_id 중 정확히 하나만 받는다 — 둘 다 보내면 422
    expect(body.token).toBeUndefined();
  });

  it("subscribe by userId sends user_id", async () => {
    const fetch = mockFetch(okEnvelope({ subscribed: true, topic: "vip", devices: 1, added: 1 }));
    const rn = new NotikitReactNative({ ...base, fetch });

    await rn.core.subscribe("vip", { userId: "user-9", identityHash: "ih" });

    const { body } = lastCall(fetch);
    expect(body).toEqual({ topic: "vip", user_id: "user-9", identity_hash: "ih" });
  });

  it("core registerDevice still accepts the deprecated externalId and sends user_id", async () => {
    const fetch = mockFetch(okEnvelope({ device: {} }));
    const rn = new NotikitReactNative({ ...base, fetch });

    await rn.core.registerDevice({ token: "t", platform: "android", externalId: "legacy" });

    const { body } = lastCall(fetch);
    expect(body.user_id).toBe("legacy");
    expect(body.external_id).toBeUndefined();
  });

  it("throws NotikitError with server message on API failure", async () => {
    const fetch = mockFetch({ success: false, data: null, error: "Invalid api key" }, 401);
    const rn = new NotikitReactNative({ ...base, fetch });

    await expect(rn.register("t", "android")).rejects.toThrowError(NotikitError);
    await expect(rn.register("t", "android")).rejects.toThrow("Invalid api key");
  });

  it("core getter exposes the underlying NotikitClient", () => {
    const rn = new NotikitReactNative({ ...base, fetch: mockFetch(okEnvelope({})) });
    expect(rn.core).toBeInstanceOf(NotikitClient);
  });
});
