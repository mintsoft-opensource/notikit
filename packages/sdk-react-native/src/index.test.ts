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
  it("register sends fcm token and platform without identity_hash when externalId is absent", async () => {
    const fetch = mockFetch(okEnvelope({ device: { id: "d1" } }));
    const rn = new NotikitReactNative({ ...base, identityHash: "ih_1", fetch });

    const res = await rn.register("fcm_token_1", "android");

    expect(res).toEqual({ device: { id: "d1" } });
    const { url, body } = lastCall(fetch);
    expect(url).toBe("https://push.test/api/v1/devices");
    expect(body.token).toBe("fcm_token_1");
    expect(body.platform).toBe("android");
    expect(body.external_id).toBeUndefined();
    expect(body.identity_hash).toBeUndefined();
  });

  it("register includes identity_hash only when externalId is provided", async () => {
    const fetch = mockFetch(okEnvelope({ device: { id: "d2" } }));
    const rn = new NotikitReactNative({ ...base, identityHash: "ih_1", fetch });

    await rn.register("fcm_token_2", "ios", "user-42");

    const { body } = lastCall(fetch);
    expect(body.platform).toBe("ios");
    expect(body.external_id).toBe("user-42");
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
    expect(body.external_id).toBe("user-9");
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
