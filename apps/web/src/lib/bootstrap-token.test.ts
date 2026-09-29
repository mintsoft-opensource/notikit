import { describe, it, expect } from "vitest";
import { bootstrapToken } from "./bootstrap-token";

const KEY = "k".repeat(40);

describe("bootstrapToken", () => {
  it("BOOTSTRAP_TOKEN 이 있으면 그 값이다", () => {
    expect(bootstrapToken({ BOOTSTRAP_TOKEN: "set-by-operator", NODE_ENV: "production", NOTIKIT_ENCRYPTION_KEY: KEY })).toBe("set-by-operator");
  });

  it("운영에서 설정이 없으면 암호화 키로 만든다 — 공개 인스턴스의 첫 관리자 자리를 아무나 선점하지 못하게", () => {
    const t = bootstrapToken({ NODE_ENV: "production", NOTIKIT_ENCRYPTION_KEY: KEY });
    expect(t).toMatch(/^[0-9a-f]{32}$/);
    // 재시작·여러 대에서도 같은 값이어야 로그에서 본 토큰으로 등록할 수 있다
    expect(bootstrapToken({ NODE_ENV: "production", NOTIKIT_ENCRYPTION_KEY: KEY })).toBe(t);
    // 키 자체가 드러나지 않는다
    expect(t).not.toContain("kkkk");
  });

  it("개발 서버에서는 요구하지 않는다", () => {
    expect(bootstrapToken({ NODE_ENV: "development", NOTIKIT_ENCRYPTION_KEY: KEY })).toBeNull();
  });
});
