import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { NotikitClient } from "@notikit/core";

const ADMIN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
const BASE = `http://localhost:${process.env.E2E_PORT ?? "3100"}`;

/**
 * 실제 SDK(@notikit/core)가 라이브 API 에 연결되는지 검증.
 * 모든 JS SDK(web/react/react-native)가 이 core 를 래핑하므로 이 테스트가 연결성을 대표한다.
 */
test.describe("SDK ↔ 라이브 API 연결", () => {
  test("@notikit/core 로 등록·식별·구독·발송 실제 호출", async ({ request }) => {
    // 프로젝트 생성(admin)
    const created = await request.post("/api/admin/projects", {
      headers: { "x-admin-token": ADMIN },
      data: { name: `sdk-it-${Date.now()}` },
    });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const ext = "sdk-it-user";
    const identityHash = createHmac("sha256", apiSecret).update(ext).digest("hex");
    const token = `sdk-it-tok-${Date.now()}`;

    // 클라이언트 SDK (공개키만) — 실제 SDK 코드가 실제 서버에 요청
    const client = new NotikitClient({ baseUrl: BASE, apiKey });

    const dev = await client.registerDevice({ token, platform: "web", externalId: ext, identityHash });
    expect(dev).toHaveProperty("device");

    const idf = await client.identify({ externalId: ext, identityHash, attributes: { plan: "pro" } });
    expect(idf).toHaveProperty("user");

    const sub = await client.subscribe("news", token);
    expect(sub.subscribed).toBe(true);

    // 발송은 서버 전용 클라이언트(secret 포함)로
    const server = new NotikitClient({ baseUrl: BASE, apiKey, apiSecret });
    const msg = await server.send({ title: "SDK", body: "integration", type: "single", target: ext });
    expect(msg).toHaveProperty("message");
  });

  test("SDK 에러 처리: 잘못된 키 → NotikitError", async () => {
    const client = new NotikitClient({ baseUrl: BASE, apiKey: "nk_invalid" });
    await expect(client.identify({ externalId: "x" })).rejects.toThrow();
  });
});
