import { describe, it, expect, vi } from "vitest";
import { NotikitClient, NotikitError, NotikitSession, memoryStorage, readPushData } from "./index";

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
    expect(JSON.parse(init.body)).toMatchObject({ token: "t1", platform: "android", user_id: "u1" });
    expect(JSON.parse(init.body)).not.toHaveProperty("external_id");
  });

  it("registerDevice sends userId as user_id", async () => {
    const fetch = mockFetch({ success: true, data: { device: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.registerDevice({ token: "t1", platform: "ios", userId: "u2", identityHash: "h2" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ user_id: "u2", identity_hash: "h2" });
    expect(body).not.toHaveProperty("external_id");
  });

  it("registerDevice prefers userId over the deprecated externalId", async () => {
    const fetch = mockFetch({ success: true, data: { device: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.registerDevice({ token: "t1", platform: "web", userId: "new", externalId: "old" });
    expect(JSON.parse((fetch as any).mock.calls[0][1].body).user_id).toBe("new");
  });

  it("registerDevice without a user sends no user key", async () => {
    const fetch = mockFetch({ success: true, data: { device: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.registerDevice({ token: "t1", platform: "web" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).not.toHaveProperty("user_id");
    expect(body).not.toHaveProperty("external_id");
  });

  it("unbindDevice sends an explicit user_id null", async () => {
    const fetch = mockFetch({ success: true, data: { device: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.unbindDevice("t1", "android", "h1");
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toEqual({ token: "t1", platform: "android", user_id: null, identity_hash: "h1" });
  });

  it("identify maps camelCase to snake_case", async () => {
    const fetch = mockFetch({ success: true, data: { user: { id: "u1" } }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.identify({ externalId: "u1", attributes: { plan: "pro" } });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ user_id: "u1", attributes: { plan: "pro" } });
    expect(body).not.toHaveProperty("external_id");
  });

  it("identify accepts userId", async () => {
    const fetch = mockFetch({ success: true, data: { user: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.identify({ userId: "u9", identityHash: "h9" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ user_id: "u9", identity_hash: "h9" });
    expect(body).not.toHaveProperty("external_id");
  });

  it("identify sends the user name", async () => {
    const fetch = mockFetch({ success: true, data: { user: {} }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.identify({ externalId: "u1", name: "김민지" });
    expect(JSON.parse((fetch as any).mock.calls[0][1].body)).toMatchObject({ user_id: "u1", name: "김민지" });
  });

  it("send maps deepLink to deep_link", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "single", target: "u1", deepLink: "https://a/1" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.deep_link).toBe("https://a/1");
  });

  it("send maps imageUrl to image_url", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "broadcast", imageUrl: "https://cdn.test/a.png" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.image_url).toBe("https://cdn.test/a.png");
    expect(body).not.toHaveProperty("imageUrl");
  });

  it("subscribe by externalId sends identity_hash with it", async () => {
    const fetch = mockFetch({ success: true, data: { topic: "vip", devices: 2 }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.subscribe("vip", { externalId: "u1", identityHash: "h1" });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/topics/subscribe");
    expect(JSON.parse(init.body)).toEqual({ topic: "vip", user_id: "u1", identity_hash: "h1" });
  });

  it("subscribe and unsubscribe by userId send user_id", async () => {
    const fetch = mockFetch({ success: true, data: { topic: "vip", devices: 1 }, error: null });
    const client = new NotikitClient({ ...base, fetch });
    await client.subscribe("vip", { userId: "u1", identityHash: "h1" });
    await client.unsubscribe("vip", { userId: "u1", identityHash: "h1" });
    for (const [, init] of (fetch as any).mock.calls) {
      expect(JSON.parse(init.body)).toEqual({ topic: "vip", user_id: "u1", identity_hash: "h1" });
    }
  });

  it("send multi posts targets instead of target", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "{{name}}", type: "multi", targets: ["u1", "u2"] });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ type: "multi", targets: ["u1", "u2"], body: "{{name}}" });
    expect(body).not.toHaveProperty("target");
  });

  it("send by template posts the template name and field values", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ type: "single", target: "u1", template: "주문 도착", fields: { order_id: "A-1" } });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ type: "single", target: "u1", template: "주문 도착", fields: { order_id: "A-1" } });
    expect(body).not.toHaveProperty("title");
  });

  it("send maps scheduledAt to an ISO scheduled_at", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "broadcast", scheduledAt: new Date("2026-10-01T09:00:00+09:00") });
    await client.send({ title: "T", body: "B", type: "broadcast", scheduledAt: "2026-10-01T09:00:00+09:00" });
    for (const [, init] of (fetch as any).mock.calls) {
      const body = JSON.parse(init.body);
      expect(body.scheduled_at).toBe("2026-10-01T00:00:00.000Z");
      expect(body).not.toHaveProperty("scheduledAt");
    }
  });

  it("send rejects an invalid scheduledAt before calling the server", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await expect(client.send({ title: "T", body: "B", type: "broadcast", scheduledAt: "not a date" })).rejects.toThrow(TypeError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("send maps variants and kakaoFallback to snake_case fields", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    const variants = [
      { title: "A", body: "a" },
      { title: "B", body: "b" },
    ];
    await client.send({ title: "T", body: "B", type: "single", target: "u1", variants, kakaoFallback: true });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.variants).toEqual(variants);
    expect(body.kakao_fallback).toBe(true);
    expect(body).not.toHaveProperty("kakaoFallback");
  });

  it("send passes idempotencyKey as the Idempotency-Key header, not in the body", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "single", target: "u1", idempotencyKey: "order-42" });
    const [, init] = (fetch as any).mock.calls[0];
    expect(init.headers["Idempotency-Key"]).toBe("order-42");
    expect(init.headers["api-key"]).toBe("nk_test");
    expect(JSON.parse(init.body)).not.toHaveProperty("idempotencyKey");
  });

  it("send without idempotencyKey sends no Idempotency-Key header", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({ title: "T", body: "B", type: "broadcast" });
    const [, init] = (fetch as any).mock.calls[0];
    expect(init.headers).not.toHaveProperty("Idempotency-Key");
    const body = JSON.parse(init.body);
    expect(body).not.toHaveProperty("scheduled_at");
    expect(body).not.toHaveProperty("variants");
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

    expect(await session.getUser()).toEqual({ userId: "u1", externalId: "u1", identityHash: "h1" });
    expect(calls[0].path).toBe("/api/v1/devices");
    expect(calls[0].body).toMatchObject({ user_id: "u1", identity_hash: "h1", token: "tok" });
    expect(calls[0].body).not.toHaveProperty("external_id");
  });

  it("login accepts userId and stores it under the new key", async () => {
    const storage = memoryStorage();
    const calls: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({ success: true, data: {} }) };
    }) as unknown as typeof fetch;
    const session = new NotikitSession(new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: fetchImpl }), storage, "web");

    await session.login({ userId: "u7" }, "tok");

    expect(JSON.parse((await storage.getItem("notikit.user")) as string)).toEqual({ userId: "u7" });
    expect(await session.getUser()).toEqual({ userId: "u7", externalId: "u7" });
    expect(calls[0]).toMatchObject({ user_id: "u7", token: "tok" });
  });

  it("reads a user stored by an older version under externalId", async () => {
    const storage = memoryStorage();
    await storage.setItem("notikit.user", JSON.stringify({ externalId: "legacy", identityHash: "h0" }));
    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })) as unknown as typeof fetch });
    expect(await new NotikitSession(client, storage, "web").getUser()).toEqual({ userId: "legacy", externalId: "legacy", identityHash: "h0" });
  });

  it("flushes a click queued by an older version for the same user", async () => {
    const storage = memoryStorage();
    await storage.setItem("notikit.user", JSON.stringify({ externalId: "u1" }));
    await storage.setItem(
      "notikit.clickQueue",
      JSON.stringify([
        { logId: "same", token: "tok", at: Date.now(), externalId: "u1" },
        { logId: "other", token: "tok", at: Date.now(), externalId: "u2" },
      ])
    );
    const client = new NotikitClient({ baseUrl: "https://p.test", apiKey: "nk", fetch: (async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) })) as unknown as typeof fetch });
    expect(await new NotikitSession(client, storage, "android").flush()).toBe(1);
    expect(await storage.getItem("notikit.clickQueue")).toBeNull();
  });

  it("logout clears the user and unbinds the device", async () => {
    const { calls, session } = setup();
    await session.login({ externalId: "u1" }, "tok");
    await session.logout("tok");

    expect(await session.getUser()).toBeNull();
    expect(calls.at(-1)?.body).toMatchObject({ user_id: null, token: "tok" });
    expect(calls.at(-1)?.body).not.toHaveProperty("external_id");
  });

  it("never sends a user id with a click — the server resolves the user from the binding", async () => {
    const { calls, session } = setup();
    await session.login({ externalId: "u1", identityHash: "h1" }, "tok");
    await session.reportClick("log1", "tok", "myapp://x");

    const click = calls.find((c) => c.path === "/api/v1/messages/click");
    expect(click?.body).toEqual({ log_id: "log1", token: "tok", destination: "myapp://x" });
    expect(click?.body).not.toHaveProperty("user_id");
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

describe("readPushData", () => {
  it("separates custom fields from notikit and FCM keys", () => {
    const r = readPushData({
      notikit_log_id: "log1",
      deep_link: "myapp://orders",
      title: "t",
      body: "b",
      "google.message_id": "x",
      "gcm.n.e": "1",
      from: "123",
      order_id: "A-1",
      screen: "order",
    });
    expect(r).toEqual({ logId: "log1", deepLink: "myapp://orders", custom: { order_id: "A-1", screen: "order" }, actions: [] });
  });

  it("returns empty custom data for non-notikit or missing payloads", () => {
    expect(readPushData(undefined)).toEqual({ custom: {}, actions: [] });
    expect(readPushData({ foo: 1 })).toEqual({ logId: undefined, deepLink: undefined, custom: {}, actions: [] });
  });
});

describe("push options and conversions", () => {
  it("send maps camelCase options to the snake_case body", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    await client.send({
      title: "T",
      body: "B",
      type: "broadcast",
      options: {
        sound: "default",
        badge: 2,
        collapseKey: "cart",
        androidChannelId: "promo",
        iosThreadId: "orders",
        ttlSeconds: 3600,
        priority: "normal",
        actions: [{ id: "buy", title: "결제", deepLink: "https://s.test/c" }],
      },
    });
    expect(JSON.parse((fetch as any).mock.calls[0][1].body).options).toEqual({
      sound: "default",
      badge: 2,
      collapse_key: "cart",
      android_channel_id: "promo",
      ios_thread_id: "orders",
      ttl_seconds: 3600,
      priority: "normal",
      actions: [{ id: "buy", title: "결제", deep_link: "https://s.test/c" }],
    });
  });

  it("send without options sends no options key", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    await new NotikitClient({ ...base, fetch }).send({ title: "T", body: "B", type: "broadcast" });
    expect(JSON.parse((fetch as any).mock.calls[0][1].body)).not.toHaveProperty("options");
  });

  it("a silent send needs no title or body", async () => {
    const fetch = mockFetch({ success: true, data: { message: {} }, error: null }, true, 202);
    await new NotikitClient({ ...base, fetch }).send({ type: "broadcast", options: { silent: true }, data: { sync: "1" } });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.options).toEqual({ silent: true });
    expect(body.data).toEqual({ sync: "1" });
  });

  it("trackConversion by token posts to /events without a user key", async () => {
    const fetch = mockFetch({ success: true, data: { recorded: true, attributed: true, message_id: "m1" }, error: null }, true, 202);
    const client = new NotikitClient({ ...base, fetch });
    const res = await client.trackConversion({ name: "purchase", valueCents: 19900, token: "t1" });

    expect(res).toEqual({ recorded: true, attributed: true, message_id: "m1" });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://push.test/api/v1/events");
    expect(JSON.parse(init.body)).toEqual({ name: "purchase", value_cents: 19900, token: "t1" });
  });

  it("trackConversion by userId sends user_id with identity_hash", async () => {
    const fetch = mockFetch({ success: true, data: { recorded: false, attributed: false }, error: null }, true, 202);
    await new NotikitClient({ ...base, fetch }).trackConversion({ name: "signup", userId: "u1", identityHash: "h1" });
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body).toMatchObject({ name: "signup", user_id: "u1", identity_hash: "h1" });
    expect(body).not.toHaveProperty("token");
  });
});

describe("readPushData actions", () => {
  it("parses data.actions and keeps it out of custom fields", () => {
    const actions = [{ id: "buy", title: "결제", deep_link: "https://s.test/c" }, { id: "later", title: "나중에" }];
    const r = readPushData({ notikit_log_id: "L1", actions: JSON.stringify(actions), order_id: "A-1" });
    expect(r.actions).toEqual([{ id: "buy", title: "결제", deepLink: "https://s.test/c" }, { id: "later", title: "나중에" }]);
    expect(r.custom).toEqual({ order_id: "A-1" });
  });

  it("drops malformed actions instead of handing the app half a button", () => {
    expect(readPushData({ actions: "not json" }).actions).toEqual([]);
    expect(readPushData({ actions: '{"id":"x"}' }).actions).toEqual([]);
    expect(readPushData({ actions: '[{"id":"x"},{"id":"y","title":"Y"}]' }).actions).toEqual([{ id: "y", title: "Y" }]);
    expect(readPushData(null).actions).toEqual([]);
  });
});
