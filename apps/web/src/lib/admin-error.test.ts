import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_ERROR_CODES, AdminApiError, adminErrorText, readApiErrorDetail, type ErrorTranslator } from "./admin-error";

// 번역 결과 대신 어떤 키·값으로 번역했는지를 돌려줘 분기를 그대로 확인한다
const t: ErrorTranslator = {
  common: (key, values) => `common.${key}${values ? JSON.stringify(values) : ""}`,
  api: (key, values) => `api.${key}${values ? JSON.stringify(values) : ""}`,
};

describe("adminErrorText", () => {
  it("translates a known server code", () => {
    const e = new AdminApiError("server", 409, "마지막 owner 는 삭제할 수 없습니다", "last_owner_delete");
    expect(adminErrorText(e, "fallback", t)).toBe("api.last_owner_delete");
  });

  it("passes server params into the translation", () => {
    const e = new AdminApiError("server", 409, "x", "update_blocked", { version: "1.2.0" });
    expect(adminErrorText(e, "fallback", t)).toBe('api.update_blocked{"version":"1.2.0"}');
  });

  it("prefers a specific code over the generic status message", () => {
    const e = new AdminApiError("server", 403, "현재 비밀번호가 올바르지 않습니다", "wrong_current_password");
    expect(adminErrorText(e, "fallback", t)).toBe("api.wrong_current_password");
  });

  it("uses the fallback, not the server text, for an unknown code", () => {
    const e = new AdminApiError("server", 400, "알 수 없는 오류", "some_future_code");
    expect(adminErrorText(e, "fallback", t)).toBe("fallback");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [429, "rate_limited"],
    [503, "server_busy"],
  ])("maps status %i without a code to %s", (status, key) => {
    const e = new AdminApiError("server", status, "Forbidden: 쓰기 권한 없음");
    expect(adminErrorText(e, "fallback", t)).toBe(`api.${key}`);
  });

  it("shows the server text when there is no code and no generic status", () => {
    const e = new AdminApiError("server", 422, "title is required");
    expect(adminErrorText(e, "fallback", t)).toBe("title is required");
  });

  it("maps a bodyless failure by status, else to the HTTP status message", () => {
    expect(adminErrorText(new AdminApiError("request_failed", 503, "x"), "fb", t)).toBe("api.server_busy");
    expect(adminErrorText(new AdminApiError("request_failed", 500, "x"), "fb", t)).toBe('common.errRequestFailed{"status":500}');
  });

  it("translates client-side codes", () => {
    expect(adminErrorText(new AdminApiError("session_expired", 401, "x"), "fb", t)).toBe("common.errSessionExpired");
    expect(adminErrorText(new AdminApiError("logout_failed", 500, "x"), "fb", t)).toBe("common.errLogoutFailed");
  });

  it("keeps plain errors and non-errors as before", () => {
    expect(adminErrorText(new Error("boom"), "fb", t)).toBe("boom");
    expect(adminErrorText("nope", "fb", t)).toBe("fb");
  });
});

describe("readApiErrorDetail", () => {
  it("reads code and scalar params only", () => {
    expect(readApiErrorDetail({ code: "update_blocked", params: { version: "1.2.0", n: 3, bad: { x: 1 } } })).toEqual({
      apiCode: "update_blocked",
      params: { version: "1.2.0", n: 3 },
    });
  });

  it("ignores malformed values", () => {
    expect(readApiErrorDetail(null)).toEqual({});
    expect(readApiErrorDetail({ code: 42, params: ["a"] })).toEqual({ apiCode: undefined });
  });
});

describe("apiErrors messages", () => {
  const dir = path.join(__dirname, "../../messages");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

  it.each(files)("%s has a message for every code", (file) => {
    const messages = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    const missing = API_ERROR_CODES.filter((code) => typeof messages.apiErrors?.[code] !== "string");
    expect(missing).toEqual([]);
  });
});
