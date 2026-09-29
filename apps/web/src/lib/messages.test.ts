import { describe, it, expect } from "vitest";
import {
  enqueuePush,
  finalizeMessage,
  holdoutError,
  localeVariantsError,
  messageSchema,
  messageDto,
  parseIdempotencyKey,
  payloadBytes,
  FCM_PAYLOAD_LIMIT,
  PERSONALIZE_HEADROOM,
  TTL_SECONDS_MAX,
  type DbOrTx,
} from "./messages";
import { sendRateLimit } from "./push-processor";
import { applyTemplate } from "./templates";

const PROJECT = "44444444-4444-4444-4444-444444444444";

/** enqueuePush 가 무엇을 저장하는지만 보는 최소 가짜 DB — insert().values().returning() */
function fakeInsertDb(rows: Array<Record<string, unknown>>): DbOrTx {
  return {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        rows.push(v);
        return { returning: async () => [{ ...v, id: `log-${rows.length}` }] };
      },
    }),
  } as unknown as DbOrTx;
}

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

describe("로케일별 문구", () => {
  const base = { type: "broadcast" as const, title: "Hi", body: "There" };

  it("변형(A/B)과 함께 쓰지 못한다 — 두 축을 곱하면 어느 쪽 폴백인지 알 수 없다", () => {
    expect(
      localeVariantsError({ ...base, locales: { ko: { title: "안녕", body: "반가워" } }, variants: [
        { title: "A", body: "a" },
        { title: "B", body: "b" },
      ] })
    ).toBe("locales cannot be combined with variants");
  });

  it("기본 문구가 어디에도 없으면 거절한다 — 맞는 로케일이 없는 사람에게 빈 알림이 간다", () => {
    const only = { type: "broadcast" as const, locales: { ko: { title: "안녕", body: "반가워" } } };
    expect(localeVariantsError(only)).toContain("locales requires");
    // title/body · template · default 중 하나만 있으면 통과
    expect(localeVariantsError({ ...only, title: "Hi", body: "There" })).toBeNull();
    expect(localeVariantsError({ ...only, template: "welcome" })).toBeNull();
    expect(localeVariantsError({ type: "broadcast", locales: { default: { title: "Hi", body: "There" } } })).toBeNull();
  });

  it("잘못된 로케일 키와 같은 값으로 접히는 중복 키를 막는다", () => {
    const parse = (locales: Record<string, { title: string; body: string }>) =>
      messageSchema.safeParse({ ...base, locales });
    expect(parse({ 한국어: { title: "a", body: "b" } }).success).toBe(false);
    // ko_KR 과 ko-KR 은 같은 언어다 — 둘 다 받으면 어느 쪽이 이기는지 입력만 보고 알 수 없다
    expect(parse({ ko_KR: { title: "a", body: "b" }, "ko-KR": { title: "c", body: "d" } }).success).toBe(false);
    expect(parse({ ko: { title: "a", body: "b" }, "ko-KR": { title: "c", body: "d" } }).success).toBe(true);
  });

  it("페이로드 크기 검사에 로케일 문구가 들어간다 — 빼면 긴 번역이 FCM 에서만 거절된다", () => {
    const short = payloadBytes({ title: "a", body: "b" });
    const withLocale = payloadBytes({ title: "a", body: "b", locales: { ja: { title: "x".repeat(200), body: "y".repeat(3000) } } });
    expect(withLocale).toBeGreaterThan(short + 3000);
  });
});

describe("홀드아웃 입력", () => {
  it("single 에는 쓸 수 없다 — 한 명뿐이라 대조군이 '전부 빼거나 안 빼거나'가 된다", () => {
    expect(holdoutError({ type: "single", holdout_percent: 10 })).toBe("holdout_percent is not available for type=single");
    expect(holdoutError({ type: "broadcast", holdout_percent: 10 })).toBeNull();
    // 테스트 발송은 운영자 자신에게 가는 것이라 무시한다(거절하지 않는다)
    expect(holdoutError({ type: "single", holdout_percent: 10, test: true })).toBeNull();
  });

  it("범위를 벗어난 비율은 거절한다", () => {
    const parse = (n: number) => messageSchema.safeParse({ type: "broadcast", title: "a", body: "b", holdout_percent: n }).success;
    expect(parse(0)).toBe(false);
    expect(parse(51)).toBe(false);
    expect(parse(10)).toBe(true);
  });
});

describe("캠페인별 재정의", () => {
  it("quiet_hours: false 면 프로젝트 방해금지 시간대를 무시하고 즉시 큐잉한다", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = fakeInsertDb(rows);
    // 0~23시 전체가 방해금지인 프로젝트 — 재정의가 없으면 반드시 미뤄진다
    const project = { id: PROJECT, quietStartHour: 0, quietEndHour: 23, timezone: "UTC" };
    const msg = { type: "broadcast" as const, title: "주문 확인", body: "결제됐습니다" };

    const quiet = await enqueuePush(project, msg, { db });
    expect(quiet.scheduled).toBe(true);

    const now = await enqueuePush(project, { ...msg, quiet_hours: false }, { db });
    expect(now.scheduled).toBe(false);
    expect(rows.at(-1)).toMatchObject({ status: "queued", ignoreQuietHours: true, scheduledAt: null });
  });

  it("max_sends_per_minute 를 저장한다 — 0 은 '이 발송은 제한 없음'이다", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const db = fakeInsertDb(rows);
    const project = { id: PROJECT, quietStartHour: null, quietEndHour: null, timezone: null };
    await enqueuePush(project, { type: "broadcast", title: "a", body: "b", max_sends_per_minute: 0 }, { db });
    expect(rows.at(-1)?.maxSendsPerMinute).toBe(0);
    await enqueuePush(project, { type: "broadcast", title: "a", body: "b" }, { db });
    expect(rows.at(-1)?.maxSendsPerMinute).toBeNull();
  });

  it("발송이 준 값이 프로젝트 설정을 덮고, 0 은 프로젝트 값으로 되돌아가지 않는다", () => {
    expect(sendRateLimit({ maxSendsPerMinute: null }, 500)).toBe(500);
    expect(sendRateLimit({ maxSendsPerMinute: 100 }, 500)).toBe(100);
    // `?? project` 로 접으면 명시적 해제가 조용히 프로젝트 값으로 되돌아간다
    expect(sendRateLimit({ maxSendsPerMinute: 0 }, 500)).toBeNull();
  });
});
