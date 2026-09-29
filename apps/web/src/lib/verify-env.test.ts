import { describe, expect, it } from "vitest";
import { insecureEnv, missingEnv } from "./verify-env";

describe("missingEnv", () => {
  const full = {
    DATABASE_URL: "postgres://x",
    NOTIKIT_ENCRYPTION_KEY: "k".repeat(32),
    SESSION_SECRET: "s".repeat(32),
  };

  it("설정이 모두 있으면 빈 배열", () => {
    expect(missingEnv(full)).toEqual([]);
  });

  it("DATABASE_URL 이 없으면 잡는다", () => {
    const { DATABASE_URL: _omit, ...rest } = full;
    expect(missingEnv(rest).join()).toContain("DATABASE_URL");
  });

  it("암호화 키가 없으면 잡는다 — 없으면 자격증명을 복호화할 수 없다", () => {
    const { NOTIKIT_ENCRYPTION_KEY: _omit, ...rest } = full;
    expect(missingEnv(rest).join()).toContain("NOTIKIT_ENCRYPTION_KEY");
  });

  it("SESSION_SECRET 이 없어도 암호화 키가 있으면 통과한다", () => {
    const { SESSION_SECRET: _omit, ...rest } = full;
    expect(missingEnv(rest)).toEqual([]);
  });

  it("세션 서명에 쓸 값이 하나도 없으면 잡는다", () => {
    expect(missingEnv({ DATABASE_URL: "postgres://x" }).join()).toContain(
      "SESSION_SECRET"
    );
  });

  it("빈 문자열은 설정된 것으로 치지 않는다", () => {
    expect(missingEnv({ ...full, DATABASE_URL: "" }).join()).toContain("DATABASE_URL");
  });
});

describe("insecureEnv", () => {
  const ok = {
    NOTIKIT_ENCRYPTION_KEY: "k".repeat(32),
    SESSION_SECRET: "s".repeat(32),
    ADMIN_TOKEN: "a-real-admin-token",
  };

  it("제대로 된 값이면 빈 배열", () => {
    expect(insecureEnv(ok)).toEqual([]);
  });

  it(".env.example 의 예시값을 그대로 두면 잡는다 — 공개 저장소에 있는 값이라 누구나 superadmin 이 된다", () => {
    const flagged = insecureEnv({
      NOTIKIT_ENCRYPTION_KEY: "change-me-32-byte-secret-minimum",
      ADMIN_TOKEN: "change-me-admin-token",
    }).join();
    expect(flagged).toContain("NOTIKIT_ENCRYPTION_KEY");
    expect(flagged).toContain("ADMIN_TOKEN");
  });

  it("암호화·세션 키가 32자보다 짧으면 잡는다", () => {
    expect(insecureEnv({ ...ok, NOTIKIT_ENCRYPTION_KEY: "short" }).join()).toContain("NOTIKIT_ENCRYPTION_KEY");
    expect(insecureEnv({ ...ok, SESSION_SECRET: "short" }).join()).toContain("SESSION_SECRET");
  });

  it("비어 있는 선택값은 문제로 보지 않는다(없음은 missingEnv 가 본다)", () => {
    expect(insecureEnv({ NOTIKIT_ENCRYPTION_KEY: "k".repeat(32) })).toEqual([]);
  });
});
