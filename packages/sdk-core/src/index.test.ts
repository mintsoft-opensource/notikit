import { describe, it, expect, vi } from "vitest";
import { NotikitClient, NotikitError, NotikitSession, memoryStorage } from "./index";

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

  it("subscribe by externalId sends identity_hash with it", async () => {
    const fetch = mockFetch({ success: true, data: { topic: "vip", devices: 2 }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.subscribe("vip", { externalId: "u1", identityHash: "h1" });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/topics/subscribe");
    expect(JSON.parse(init.body)).toEqual({ topic: "vip", external_id: "u1", identity_hash: "h1" });
  });

  it("send multi posts targets instead of target", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "{{name}}", type: "multi", targets: ["u1", "u2"] });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ type: "multi", targets: ["u1", "u2"], body: "{{name}}" });
    expect(body).not.toHaveProperty("target");
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

describe("NotikitSession", () => {
  function setup(fail = false) {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      calls.push({ path, body: JSON.parse(init.body) });
      if (fail && path === "/api/v1/messages/click") throw new Error("offline");
      return { ok: true, status: 200, json: async () => ({ success: true, data: { recorded: true } }) };
    }) as unknown as typeof fetch;

    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: fetchImpl });
    return { calls, session: new NotikitSession(client, memoryStorage(), "android") };
  }

  it("login stores the user and binds the device", async () => {
    const { calls, session } = setup();
    await session.login({ externalId: "u1", identityHash: "h1" }, "tok");

    expect(await session.getUser()).toEqual({ externalId: "u1", identityHash: "h1" });
    expect(calls[0].path).toBe("/api/v1/devices");
    expect(calls[0].body).toMatchObject({ external_id: "u1", identity_hash: "h1", token: "tok" });
  });

  it("logout clears the user and unbinds the device", async () => {
    const { calls, session } = setup();
    await session.login({ externalId: "u1" }, "tok");
    await session.logout("tok");

    expect(await session.getUser()).toBeNull();
    expect(calls.at(-1)?.body).toMatchObject({ external_id: null, token: "tok" });
  });

  it("never sends external_id with a click — the server resolves the user from the binding", async () => {
    const { calls, session } = setup();
    await session.login({ externalId: "u1", identityHash: "h1" }, "tok");
    await session.reportClick("log1", "tok", "myapp://x");

    const click = calls.find((c) => c.path === "/api/v1/messages/click");
    expect(click?.body).toEqual({ log_id: "log1", token: "tok", destination: "myapp://x" });
    expect(click?.body).not.toHaveProperty("external_id");
  });

  it("queues a failed click and resends it on flush", async () => {
    const failing = setup(true);
    expect(await failing.session.reportClick("log1", "tok")).toBe(false);

    // 같은 발송의 재클릭은 큐에서 접힌다
    await failing.session.reportClick("log1", "tok");

    const storage = memoryStorage();
    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })) as unknown as typeof fetch });
    const s2 = new NotikitSession(client, storage, "android");
    await storage.setItem("notikit.clickQueue", JSON.stringify([{ logId: "log1", token: "tok", at: Date.now() }]));
    expect(await s2.flush()).toBe(1);
    expect(await storage.getItem("notikit.clickQueue")).toBeNull();
  });

  it("drops queued clicks older than the TTL", async () => {
    const storage = memoryStorage();
    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })) as unknown as typeof fetch });
    const session = new NotikitSession(client, storage, "android");
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await storage.setItem("notikit.clickQueue", JSON.stringify([{ logId: "old", token: "tok", at: eightDaysAgo }]));

    expect(await session.flush()).toBe(0);
  });

  it("survives a corrupted storage value instead of throwing", async () => {
    const storage = memoryStorage();
    await storage.setItem("notikit.user", "{not json");
    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })) as unknown as typeof fetch });
    expect(await new NotikitSession(client, storage, "web").getUser()).toBeNull();
  });
});
