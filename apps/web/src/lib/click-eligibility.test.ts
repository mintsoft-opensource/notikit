import { describe, it, expect } from "vitest";
import type { PushLog } from "@/db/schema";
import { latestSendAt } from "./click-eligibility";

const NOW = new Date("2026-09-29T12:00:00Z");
const log = (over: Partial<PushLog>) =>
  ({ createdAt: new Date("2026-09-29T00:00:00Z"), scheduledAt: null, lockedAt: null, status: "completed", ...over }) as PushLog;

describe("latestSendAt", () => {
  it("끝난 발송은 마지막으로 보낸 시각까지 — 그 뒤에 등록된 기기는 받을 수 없었다", () => {
    const at = latestSendAt(log({ lockedAt: new Date("2026-09-29T09:05:00Z") }), NOW);
    expect(at.toISOString()).toBe("2026-09-29T09:05:00.000Z");
  });

  it("아직 보내는 중이면 지금까지 — 현지 시각·속도 제한 발송은 큐잉 뒤 가입한 기기에도 나간다", () => {
    for (const status of ["queued", "scheduled", "processing"]) {
      expect(latestSendAt(log({ status }), NOW)).toEqual(NOW);
    }
  });

  it("예약 시각이 마지막 활동보다 늦으면 예약 시각을 쓴다", () => {
    const at = latestSendAt(log({ scheduledAt: new Date("2026-09-29T10:00:00Z"), lockedAt: new Date("2026-09-29T09:00:00Z") }), NOW);
    expect(at.toISOString()).toBe("2026-09-29T10:00:00.000Z");
  });

  it("기록이 없는 옛 로그는 큐잉 시각이다", () => {
    expect(latestSendAt(log({}), NOW).toISOString()).toBe("2026-09-29T00:00:00.000Z");
  });
});
