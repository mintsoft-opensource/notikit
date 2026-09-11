import { describe, it, expect } from "vitest";
import { generateKeyPair, issueLicense, verifyLicense } from "@notikit/license";

const { publicKey, privateKey } = generateKeyPair();
const future = "2099-01-01T00:00:00Z";

describe("license", () => {
  it("발급한 라이선스를 공개키로 검증한다", () => {
    const token = issueLicense({ customerId: "acme", customerName: "Acme", expiresAt: future }, privateKey);
    const r = verifyLicense(token, publicKey);
    expect(r.status).toBe("valid");
    if (r.status === "valid") expect(r.license.customerId).toBe("acme");
  });

  it("내용을 고치면 서명이 깨진다 — 한도를 늘려도 통과하지 못한다", () => {
    const token = issueLicense({ customerId: "acme", expiresAt: future, limits: { projects: 1 } }, privateKey);
    const [prefix, body, sig] = token.split(".");
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    payload.limits.projects = 9999;
    const forged = `${prefix}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;

    expect(verifyLicense(forged, publicKey).status).toBe("invalid");
  });

  it("다른 키로 서명한 라이선스는 받지 않는다", () => {
    const other = generateKeyPair();
    const token = issueLicense({ customerId: "x", expiresAt: future }, other.privateKey);
    expect(verifyLicense(token, publicKey).status).toBe("invalid");
  });

  it("만료는 위조와 구분된다 — 영업이 풀 일과 보안 사건은 대응이 다르다", () => {
    const token = issueLicense({ customerId: "acme", expiresAt: "2020-01-01T00:00:00Z" }, privateKey);
    const r = verifyLicense(token, publicKey);
    expect(r.status).toBe("expired");
    // 만료여도 누구의 라이선스였는지는 알아야 갱신 안내를 할 수 있다
    if (r.status === "expired") expect(r.license.customerId).toBe("acme");
  });

  it("공개키가 없으면 통과시키지 않는다", () => {
    const token = issueLicense({ customerId: "acme", expiresAt: future }, privateKey);
    expect(verifyLicense(token, "").status).toBe("invalid");
  });

  it("만료 없는 라이선스는 발급하지 않는다 — 회수할 방법이 없다", () => {
    expect(() => issueLicense({ customerId: "acme", expiresAt: "" }, privateKey)).toThrow();
  });
});
