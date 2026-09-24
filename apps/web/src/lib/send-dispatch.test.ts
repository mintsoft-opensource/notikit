import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PushLog, Project } from "@/db/schema";
import type { FcmResult } from "@/lib/fcm";

const { calls, queue } = vi.hoisted(() => ({ calls: [] as string[][], queue: [] as FcmResult[] }));

vi.mock("@/lib/fcm", () => ({
  SEND_EACH_LIMIT: 500,
  sendToTokens: (_p: string, _sa: unknown, tokens: string[]) => {
    calls.push(tokens);
    return Promise.resolve(queue.shift()!);
  },
  sendEachToTokens: () => Promise.resolve(queue.shift()!),
}));

import { dispatchItems, type SendContext, type SendItem } from "./send-dispatch";

const log = { id: "log-1" } as unknown as PushLog;
const ctx = {
  project: { id: "proj-1" } as unknown as Project,
  sa: {} as never,
  cap: null,
  renderCtx: { appName: "P", now: new Date() },
  personalized: false,
  rateLimit: null,
  localTime: null,
} satisfies SendContext;

const items: SendItem[] = ["a", "b"].map((token) => ({ token, vi: null, title: "T", body: "B", dataOnly: false }));
const result = (o: Partial<FcmResult>): FcmResult => ({
  success: 0,
  failure: 0,
  invalidTokens: [],
  validTokens: [],
  failures: [],
  ...o,
});
const nowait = () => Promise.resolve();

beforeEach(() => {
  calls.length = 0;
  queue.length = 0;
});

describe("dispatchItems", () => {
  it("일시 실패한 토큰만 다시 보내고, 성공하면 실패로 세지 않는다", async () => {
    queue.push(
      result({
        success: 1,
        failure: 1,
        validTokens: ["a"],
        failures: [{ token: "b", code: "messaging/quota-exceeded", retryable: true }],
      }),
      result({ success: 1, failure: 0, validTokens: ["b"] })
    );

    const { result: r, errors } = await dispatchItems(ctx, log, items, nowait);
    expect(calls).toEqual([["a", "b"], ["b"]]); // 재시도는 실패한 토큰만
    expect(r.success).toBe(2);
    expect(r.failure).toBe(0);
    expect(errors).toEqual([]);
  });

  it("한도까지 다시 보내고도 실패하면 사유를 남긴다 — 예전에는 수만 세고 버려 원인이 남지 않았다", async () => {
    const quota = result({
      success: 1,
      failure: 1,
      validTokens: ["a"],
      failures: [{ token: "b", code: "messaging/quota-exceeded", retryable: true }],
    });
    queue.push(quota, { ...quota, success: 0, failure: 1, validTokens: [] }, { ...quota, success: 0, failure: 1, validTokens: [] });

    const { result: r, errors } = await dispatchItems(ctx, log, items, nowait);
    expect(calls).toHaveLength(3); // 최초 1 + 재시도 2
    expect(r.success).toBe(1);
    expect(r.failure).toBe(1);
    expect(errors).toEqual(["messaging/quota-exceeded"]);
    expect(r.invalidTokens).toEqual([]);
  });

  it("무효 토큰은 다시 보내지 않는다 — 같은 답이 올 뿐이고 삭제 신호는 그대로 남긴다", async () => {
    queue.push(
      result({
        success: 1,
        failure: 1,
        validTokens: ["a"],
        invalidTokens: ["b"],
        failures: [{ token: "b", code: "messaging/registration-token-not-registered", retryable: false }],
      })
    );

    const { result: r, errors } = await dispatchItems(ctx, log, items, nowait);
    expect(calls).toHaveLength(1);
    expect(r.invalidTokens).toEqual(["b"]);
    expect(errors).toEqual(["messaging/registration-token-not-registered"]);
  });
});
