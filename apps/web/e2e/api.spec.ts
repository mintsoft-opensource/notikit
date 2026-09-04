import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";

const ADMIN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";

/** 고객 서버가 계산하는 identity 검증 해시 */
function idHash(externalId: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(externalId).digest("hex");
}

/** 관리자 API 로 프로젝트 생성 → api-key/secret 획득 */
async function createProject(request: APIRequestContext) {
  const res = await request.post("/api/admin/projects", {
    headers: { "x-admin-token": ADMIN },
    data: { name: `e2e-${Date.now()}`, environment: "production" },
  });
  expect(res.status()).toBe(201);
  const json = await res.json();
  return {
    apiKey: json.data.project.apiKey as string,
    apiSecret: json.data.api_secret as string,
  };
}

test.describe("App SDK API 전체 플로우", () => {
  test("admin: 프로젝트 생성 시 secret 은 1회만 반환", async ({ request }) => {
    const res = await request.post("/api/admin/projects", {
      headers: { "x-admin-token": ADMIN },
      data: { name: `e2e-secret-${Date.now()}` },
    });
    expect(res.status()).toBe(201);
    const json = await res.json();
    expect(json.data.api_secret).toMatch(/^sk_/);
    expect(json.data.project.apiSecretHash).toBeUndefined(); // 해시는 노출 안 됨... (select 는 포함하나 평문 아님)
  });

  test("admin: 잘못된 토큰이면 401", async ({ request }) => {
    const res = await request.get("/api/admin/projects", { headers: { "x-admin-token": "wrong" } });
    expect(res.status()).toBe(401);
  });

  test("admin: Firebase 크레덴셜 웹 업로드 (검증 + 암호화 저장)", async ({ request }) => {
    const created = await request.post("/api/admin/projects", {
      headers: { "x-admin-token": ADMIN },
      data: { name: `fb-${Date.now()}` },
    });
    const pid = (await created.json()).data.project.id;

    // 잘못된 서비스계정 → 422
    const bad = await request.post(`/api/admin/projects/${pid}/firebase`, {
      headers: { "x-admin-token": ADMIN },
      data: { credentials: { foo: "bar" } },
    });
    expect(bad.status()).toBe(422);

    // 유효 형태 → 200 configured (암호화 저장; 실제 FCM init 은 발송 시)
    const good = await request.post(`/api/admin/projects/${pid}/firebase`, {
      headers: { "x-admin-token": ADMIN },
      data: {
        credentials: {
          type: "service_account",
          project_id: "demo-proj",
          private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
          client_email: "sdk@demo-proj.iam.gserviceaccount.com",
        },
      },
    });
    expect(good.status()).toBe(200);
    const gj = await good.json();
    expect(gj.data.configured).toBe(true);
    expect(gj.data.firebase_project_id).toBe("demo-proj");
  });

  test("device 등록 → identify → subscribe → send 큐잉", async ({ request }) => {
    const { apiKey, apiSecret } = await createProject(request);
    // 클라이언트(등록/식별)는 api-key 만. identity_hash 로 external_id 바인딩 증명.
    const pub = { "api-key": apiKey };
    const token = `tok-${Date.now()}`;
    const hash = idHash("user-1", apiSecret);

    // 1) 디바이스 등록 (유저 연결 + identity 검증)
    const dev = await request.post("/api/v1/devices", {
      headers: pub,
      data: { token, platform: "android", external_id: "user-1", identity_hash: hash, locale: "ko-KR" },
    });
    expect(dev.status()).toBe(201);

    // 2) 유저 식별
    const idf = await request.post("/api/v1/users/identify", {
      headers: pub,
      data: { external_id: "user-1", identity_hash: hash, attributes: { plan: "pro" } },
    });
    expect(idf.status()).toBe(200);

    // 3) 토픽 구독 (public)
    const sub = await request.post("/api/v1/topics/subscribe", {
      headers: pub,
      data: { topic: "news", token },
    });
    expect(sub.status()).toBe(200);

    // 4) 발송 큐잉 (privileged: secret 필요)
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "안녕", body: "본문", type: "single", target: "user-1", deep_link: "https://app/orders/1" },
    });
    expect(send.status()).toBe(202);
    const sendJson = await send.json();
    expect(sendJson.data.message.status).toBe("queued");
  });

  test("스코프: 등록은 api-key 만으로 가능(공개), 발송은 secret 필수", async ({ request }) => {
    const { apiKey } = await createProject(request);

    // 공개 엔드포인트(등록) — api-key 만으로 201
    const reg = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token: `pub-${Date.now()}`, platform: "web" },
    });
    expect(reg.status()).toBe(201);

    // 권한 엔드포인트(발송) — secret 없으면 401
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey },
      data: { title: "t", body: "b", type: "broadcast" },
    });
    expect(send.status()).toBe(401);
  });

  test("보안: external_id 바인딩에 identity_hash 없으면 403", async ({ request }) => {
    const { apiKey } = await createProject(request);
    const res = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token: `t-${Date.now()}`, platform: "web", external_id: "victim" }, // hash 누락
    });
    expect(res.status()).toBe(403);
  });

  test("검증: single 인데 target 없으면 422", async ({ request }) => {
    const { apiKey, apiSecret } = await createProject(request);
    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "single" },
    });
    expect(res.status()).toBe(422);
  });
});
