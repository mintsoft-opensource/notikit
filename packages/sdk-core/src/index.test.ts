import { describe, it, expect, vi } from "vitest";
import { NotikitClient, NotikitError } from "./index";

function mockFetch(response: unknown, ok = true, status = 200) {
  return vi.fn(async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    })
  ) as unknown as typeof fetch;
}

const base = { baseUrl: "https://push.test", apiKey: "nk_test", apiSecret: "sk_test" };

describe("NotikitClient", () => {
  it("registerDevice sends correct payload and headers", async () => {
    const fetch = mockFetch({ success: true, data: { device: { id: "d1" } }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    const res = await client.registerDevice({ token: "t1", platform: "android", externalId: "u1" });

    expect(res).toEqual({ device: { id: "d1" } });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/devices");
    expect(init.headers["api-key"]).toBe("nk_test");
    expect(init.headers["api-secret"]).toBe("sk_test");
    expect(JSON.parse(init.body)).toMatchObject({ token: "t1", platform: "android", external_id: "u1" });
  });

  it("identify maps camelCase to snake_case", async () => {
    const fetch = mockFetch({ success: true, data: { user: { id: "u1" } }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.identify({ externalId: "u1", attributes: { plan: "pro" } });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ external_id: "u1", attributes: { plan: "pro" } });
  });

  it("send maps deepLink to deep_link", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "single", target: "u1", deepLink: "https://a/1" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.deep_link).toBe("https://a/1");
  });

  it("throws NotikitError on failure envelope", async () => {
    const fetch = mockFetch({ success: false, data: null, error: "Unauthorized" }, false, 401);
    const client = new NotikitClient({ ...base, fetch });
    await expect(client.subscribe("news", "t1")).rejects.toBeInstanceOf(NotikitError);
  });

  it("sends api-secret only when provided (client-safe by default)", async () => {
    const withSecret = mockFetch({ success: true, data: {}, error: null });
    await new NotikitClient({ baseUrl: base.baseUrl, apiKey: "nk", apiSecret: "sk", fetch: withSecret }).identify({ externalId: "u1" });
    expect((withSecret as any).mock.calls[0][1].headers["api-secret"]).toBe("sk");

    const noSecret = mockFetch({ success: true, data: {}, error: null });
    await new NotikitClient({ baseUrl: base.baseUrl, apiKey: "nk", fetch: noSecret }).identify({ externalId: "u1" });
    expect((noSecret as any).mock.calls[0][1].headers["api-secret"]).toBeUndefined();
  });
});
