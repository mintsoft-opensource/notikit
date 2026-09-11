import { describe, it, expect, afterEach } from "vitest";
import { clientIp, maskIp } from "./client-ip";

const req = (xff?: string) =>
  new Request("https://x/y", { headers: xff ? { "x-forwarded-for": xff } : {} });

afterEach(() => { delete process.env.TRUSTED_PROXY_HOPS; });

describe("clientIp", () => {
  it("프록시 미설정이면 헤더를 믿지 않는다", () => {
    expect(clientIp(req("1.2.3.4"))).toBeNull();
  });
  it("홉 1: 가장 오른쪽이 프록시, 그 왼쪽이 클라이언트", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req("203.0.113.5"))?.ip).toBe("203.0.113.5");
  });
  it("홉 1에서 위조된 앞쪽 값을 쓰지 않는다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req("9.9.9.9, 203.0.113.5"))?.ip).toBe("203.0.113.5");
  });
  it("홉 2: CDN + 프록시", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    expect(clientIp(req("203.0.113.5, 10.0.0.1"))?.ip).toBe("203.0.113.5");
  });
  it("IPv4-mapped 와 포트를 벗긴다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req("::ffff:203.0.113.5"))?.ip).toBe("203.0.113.5");
    expect(clientIp(req("203.0.113.5:41234"))?.ip).toBe("203.0.113.5");
  });
  it("IPv6 를 family 6 으로 판별한다", () => {
    process.env.TRUSTED_PROXY_HOPS = "1";
    expect(clientIp(req("2001:db8:1234:5678::1"))).toEqual({ ip: "2001:db8:1234:5678::1", family: 6 });
  });
});

describe("maskIp", () => {
  it("IPv4 는 /24", () => {
    expect(maskIp({ ip: "203.0.113.5", family: 4 })).toBe("203.0.113.0");
  });
  it("IPv6 는 /48", () => {
    expect(maskIp({ ip: "2001:db8:1234:5678::1", family: 6 })).toBe("2001:db8:1234::");
  });
  it("축약된 IPv6 도 편 뒤 자른다", () => {
    expect(maskIp({ ip: "2001:db8::1", family: 6 })).toBe("2001:db8:0::");
  });
});
