import { describe, it, expect, vi } from "vitest";
import { buildMulticast, classifyResponses } from "./fcm";

const msg = { title: "T", body: "B", logId: "L1", imageUrl: "https://cdn.test/a.png" };

describe("buildMulticast image", () => {
  it("native: notification.imageUrl plus APNs mutable-content and fcm_options image", () => {
    const p = buildMulticast(msg, false);
    expect(p.notification).toEqual({ title: "T", body: "B", imageUrl: "https://cdn.test/a.png" });
    expect(p.apns).toEqual({ payload: { aps: { mutableContent: true } }, fcmOptions: { imageUrl: "https://cdn.test/a.png" } });
  });

  it("web data-only: image travels in data.image, no notification block", () => {
    const p = buildMulticast(msg, true);
    expect(p).not.toHaveProperty("notification");
    expect(p).not.toHaveProperty("apns");
    expect(p.data).toMatchObject({ title: "T", body: "B", image: "https://cdn.test/a.png", notikit_log_id: "L1" });
  });

  it("omits image fields when no image", () => {
    const p = buildMulticast({ title: "T", body: "B" }, false);
    expect(p.notification).toEqual({ title: "T", body: "B" });
    expect(p).not.toHaveProperty("apns");
  });
});

describe("classifyResponses", () => {
  it("separates accepted, invalid-token and undecidable failures", () => {
    const r = classifyResponses(["ok", "gone", "quota"], {
      successCount: 1,
      failureCount: 2,
      responses: [
        { success: true },
        { success: false, error: { code: "messaging/registration-token-not-registered" } },
        { success: false, error: { code: "messaging/quota-exceeded" } },
      ],
    } as unknown as Parameters<typeof classifyResponses>[1]);
    expect(r).toEqual({ success: 1, failure: 2, validTokens: ["ok"], invalidTokens: ["gone"] });
  });
});

describe("buildMulticast options", () => {
  const base = { title: "T", body: "B", logId: "L1" };

  it("maps android ttl/priority/collapse and notification channel+sound", () => {
    const p = buildMulticast(
      { ...base, options: { ttl_seconds: 3600, priority: "normal", collapse_key: "cart", android_channel_id: "promo", sound: "ding.caf" } },
      false
    );
    expect(p.android).toEqual({
      ttl: 3_600_000,
      priority: "normal",
      collapseKey: "cart",
      notification: { channelId: "promo", sound: "ding.caf" },
    });
  });

  it("maps APNs sound/badge/thread-id/collapse-id and expiration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const p = buildMulticast({ ...base, options: { sound: "default", badge: 3, ios_thread_id: "orders", collapse_key: "cart", ttl_seconds: 60 } }, false);
      expect(p.apns).toEqual({
        headers: { "apns-collapse-id": "cart", "apns-expiration": String(Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000) + 60) },
        payload: { aps: { sound: "default", badge: 3, threadId: "orders" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ttl 0 keeps apns-expiration 0 — expire now, not one second from now", () => {
    const p = buildMulticast({ ...base, options: { ttl_seconds: 0 } }, false);
    expect((p.apns as { headers: Record<string, string> }).headers["apns-expiration"]).toBe("0");
    expect(p.android).toEqual({ ttl: 0 });
  });

  it("silent: no notification anywhere, no title/body in data, APNs content-available at priority 5", () => {
    const p = buildMulticast({ ...base, options: { silent: true, badge: 0 } }, false);
    expect(p).not.toHaveProperty("notification");
    expect(p.data).toEqual({ notikit_log_id: "L1" });
    expect(p.apns).toEqual({ headers: { "apns-priority": "5" }, payload: { aps: { contentAvailable: true, badge: 0 } } });
    expect(p.android).toBeUndefined();
  });

  it("silent never carries an android notification block even with channel/sound", () => {
    const p = buildMulticast({ ...base, options: { silent: true, android_channel_id: "promo", sound: "default", priority: "high" } }, false);
    expect(p.android).toEqual({ priority: "high" });
  });

  it("web data-only drops the android notification block but keeps ttl/collapse", () => {
    const p = buildMulticast({ ...base, options: { android_channel_id: "promo", collapse_key: "cart", ttl_seconds: 10 } }, true);
    expect(p.android).toEqual({ ttl: 10_000, collapseKey: "cart" });
    expect(p.data).toMatchObject({ title: "T", body: "B" });
  });

  it("actions travel as a JSON string in data and win over custom data", () => {
    const actions = [{ id: "buy", title: "결제", deep_link: "https://s.test/c" }];
    const p = buildMulticast({ ...base, data: { actions: "forged" }, options: { actions } }, false);
    expect(p.data?.actions).toBe(JSON.stringify(actions));
  });

  it("no options means no android/apns blocks at all", () => {
    const p = buildMulticast(base, false);
    expect(p).not.toHaveProperty("android");
    expect(p).not.toHaveProperty("apns");
  });
});
