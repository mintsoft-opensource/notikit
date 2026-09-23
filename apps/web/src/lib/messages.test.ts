import { describe, it, expect } from "vitest";
import { finalizeMessage, messageSchema, messageDto, parseIdempotencyKey, payloadBytes, FCM_PAYLOAD_LIMIT, PERSONALIZE_HEADROOM, TTL_SECONDS_MAX } from "./messages";
import { applyTemplate } from "./templates";

const RESERVED = [{ notikit_log_id: "x" }, { deep_link: "x" }, { "google.x": "1" }];

describe("messageSchema data", () => {
  it("rejects reserved keys in data with the key in the message", () => {
    for (const data of RESERVED) {
      const r = messageSchema.safeParse({ type: "broadcast", title: "t", body: "b", data });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toBe(`data key is reserved: ${Object.keys(data)[0]}`);
    }
  });

  it("accepts ordinary keys", () => {
    expect(messageSchema.safeParse({ type: "broadcast", title: "t", body: "b", data: { order_id: "1" } }).success).toBe(true);
  });
});

describe("finalizeMessage", () => {
  it("rejects reserved keys that arrive after merging with a template", () => {
    // 규칙이 생기기 전에 저장된 템플릿이 예약 키를 들고 있는 경우
    const tpl = { title: "t", body: "b", deepLink: null, fields: [{ key: "notikit_log_id", default: "forged" }] };
    const applied = applyTemplate(tpl, {});
    expect("error" in applied).toBe(false);
    if ("error" in applied) return;
    expect(finalizeMessage({ type: "broadcast", ...applied })).toEqual({ error: "data key is reserved: notikit_log_id", status: 422 });
  });

  it("passes a merged message without reserved keys", () => {
    const tpl = { title: "t", body: "b", deepLink: null, fields: [{ key: "order_id", default: "A-1" }] };
    const applied = applyTemplate(tpl, {});
    if ("error" in applied) throw new Error(applied.error);
    const r = finalizeMessage({ type: "broadcast", ...applied });
    expect(r).toEqual({ message: { type: "broadcast", title: "t", body: "b", data: { order_id: "A-1" } } });
  });
});

describe("messageSchema image_url", () => {
  const base = { type: "broadcast", title: "t", body: "b" } as const;

  it("rejects http image URLs", () => {
    const r = messageSchema.safeParse({ ...base, image_url: "http://cdn.test/a.png" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]?.message).toBe("image_url must be an https URL");
  });

  it("accepts https image URLs", () => {
    expect(messageSchema.safeParse({ ...base, image_url: "https://cdn.test/a.png" }).success).toBe(true);
  });

  it("rejects image URLs over 2048 chars", () => {
    const long = `https://cdn.test/${"a".repeat(2048)}`;
    expect(messageSchema.safeParse({ ...base, image_url: long }).success).toBe(false);
  });
});

describe("FCM payload size", () => {
  const base = { type: "broadcast" as const, title: "t", body: "b" };

  it("rejects messages whose serialized payload exceeds 4KB", () => {
    const r = finalizeMessage({ ...base, body: "x".repeat(3900), data: { a: "y".repeat(400) } });
    expect(r).toMatchObject({ status: 422 });
    if ("error" in r) expect(r.error).toMatch(/payload too large for FCM/);
  });

  it("reserves headroom for personalization placeholders", () => {
    const body = "x".repeat(FCM_PAYLOAD_LIMIT - 400);
    expect("message" in finalizeMessage({ ...base, body })).toBe(true);
    expect(payloadBytes({ ...base, body: `${body}{{name}}` })).toBeGreaterThan(payloadBytes({ ...base, body }) + PERSONALIZE_HEADROOM - 1);
  });

  it("checks the longest variant", () => {
    const variants = [{ title: "a", body: "a" }, { title: "b", body: "z".repeat(4200) }];
    expect(finalizeMessage({ ...base, variants })).toMatchObject({ status: 422 });
  });
});

describe("parseIdempotencyKey", () => {
  const req = (v?: string) => new Request("http://x", { headers: v === undefined ? {} : { "Idempotency-Key": v } });

  it("returns null without the header and the trimmed key with it", () => {
    expect(parseIdempotencyKey(req())).toEqual({ key: null });
    expect(parseIdempotencyKey(req(" order-42 "))).toEqual({ key: "order-42" });
  });

  it("rejects empty, overlong or non-printable keys", () => {
    expect("error" in parseIdempotencyKey(req(""))).toBe(true);
    expect("error" in parseIdempotencyKey(req("a".repeat(256)))).toBe(true);
    expect("error" in parseIdempotencyKey(req("a b"))).toBe(true);
  });
});

describe("messageDto", () => {
  it("exposes only id, status and scheduled_at", () => {
    const at = new Date("2026-09-22T00:00:00Z");
    expect(messageDto({ id: "m1", status: "scheduled", scheduledAt: at })).toEqual({ id: "m1", status: "scheduled", scheduled_at: at.toISOString() });
    expect(messageDto({ id: "m2", status: "queued", scheduledAt: null })).toEqual({ id: "m2", status: "queued", scheduled_at: null });
  });
});

describe("messageSchema options", () => {
  const send = (options: unknown) => messageSchema.safeParse({ type: "broadcast", title: "t", body: "b", options });

  it("defaults priority to high — 푸시는 즉시 도착이 기본 기대값", () => {
    const r = send({ sound: "default" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.options).toEqual({ sound: "default", priority: "high" });
  });

  it("rejects ttl outside 0..28 days, a negative badge and an unknown priority", () => {
    expect(send({ ttl_seconds: -1 }).success).toBe(false);
    expect(send({ ttl_seconds: TTL_SECONDS_MAX + 1 }).success).toBe(false);
    expect(send({ ttl_seconds: TTL_SECONDS_MAX }).success).toBe(true);
    expect(send({ badge: -1 }).success).toBe(false);
    expect(send({ priority: "urgent" }).success).toBe(false);
  });

  it("caps actions at 3 and rejects duplicate ids", () => {
    const a = (id: string) => ({ id, title: id });
    expect(send({ actions: [a("1"), a("2"), a("3")] }).success).toBe(true);
    expect(send({ actions: [a("1"), a("2"), a("3"), a("4")] }).success).toBe(false);
    expect(send({ actions: [a("1"), a("1")] }).success).toBe(false);
    expect(send({ actions: [{ id: "1", title: "t", deep_link: "not-a-url" }] }).success).toBe(false);
  });
});

describe("finalizeMessage silent", () => {
  it("accepts a silent push without title or body", () => {
    const r = finalizeMessage({ type: "broadcast", options: { silent: true }, data: { sync: "1" } });
    expect(r).toEqual({ message: { type: "broadcast", title: "", body: "", options: { silent: true }, data: { sync: "1" } } });
  });

  it("still requires title and body when it is not silent", () => {
    expect(finalizeMessage({ type: "broadcast", options: { silent: false } })).toMatchObject({ status: 422 });
  });
});

describe("payloadBytes options", () => {
  it("counts action buttons — they ride in data and eat the 4KB budget", () => {
    const base = { title: "t", body: "b" } as const;
    const withActions = payloadBytes({ ...base, options: { actions: [{ id: "buy", title: "결제하기", deep_link: "https://shop.test/cart" }] } });
    expect(withActions).toBeGreaterThan(payloadBytes(base));
  });

  it("rejects a message whose options push it past the FCM limit", () => {
    const long = "x".repeat(64);
    const actions = Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, title: long, deep_link: `https://s.test/${"y".repeat(1200)}` }));
    const r = finalizeMessage({ type: "broadcast", title: "t", body: "b", options: { actions } });
    expect(r).toMatchObject({ status: 422 });
    if ("error" in r) expect(r.error).toContain("payload too large for FCM");
  });
});
