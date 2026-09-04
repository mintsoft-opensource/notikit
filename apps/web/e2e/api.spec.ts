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

  test("발송 파이프라인: log-only 큐 처리 → 대상 해석·기록", async ({ request }) => {
    const created = await request.post("/api/admin/projects", {
      headers: { "x-admin-token": ADMIN },
      data: { name: `flow-${Date.now()}` },
    });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const projectId = cj.data.project.id as string;
    const ext = "flow-user";
    const hash = idHash(ext, apiSecret);
    const token = `flow-tok-${Date.now()}`;

    // 유저 연결 디바이스 등록
    const reg = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "web", external_id: ext, identity_hash: hash },
    });
    expect(reg.status()).toBe(201);

    // 발송 큐잉
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "single", target: ext },
    });
    expect(send.status()).toBe(202);

    // 큐 처리 (Firebase 미구성 → log-only, 대상 1건 기록)
    const proc = await request.post(`/api/admin/projects/${projectId}/process-queue`, {
      headers: { "x-admin-token": ADMIN },
      data: {},
    });
    expect(proc.status()).toBe(200);
    const pj = await proc.json();
    expect(pj.data.processed).toBeGreaterThanOrEqual(1);
    expect(pj.data.failed).toBe(0);
  });

  test("예약 발송: 미래=scheduled(처리 스킵), 과거=즉시 처리", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sch-${Date.now()}` } });
    const cj = await created.json();
    const { apiKey } = { apiKey: cj.data.project.apiKey as string };
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const auth = { "api-key": apiKey, "api-secret": apiSecret };

    const future = await request.post("/api/v1/messages", { headers: auth, data: { title: "f", body: "b", type: "broadcast", scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } });
    expect((await future.json()).data.message.status).toBe("scheduled");
    const proc1 = await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    expect((await proc1.json()).data.processed).toBe(0);

    const past = await request.post("/api/v1/messages", { headers: auth, data: { title: "p", body: "b", type: "broadcast", scheduled_at: new Date(Date.now() - 1000).toISOString() } });
    expect((await past.json()).data.message.status).toBe("queued");
    const proc2 = await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    expect((await proc2.json()).data.processed).toBeGreaterThanOrEqual(1);
  });

  test("웹훅: 등록 시 secret 1회, 목록엔 secret 제외", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `wh-${Date.now()}` } });
    const pid = (await created.json()).data.project.id;

    const wh = await request.post(`/api/admin/projects/${pid}/webhooks`, { headers: { "x-admin-token": ADMIN }, data: { url: "https://example.com/hook", events: ["message.sent"] } });
    expect(wh.status()).toBe(201);
    expect((await wh.json()).data.secret).toMatch(/^whsec_/);

    const list = await request.get(`/api/admin/projects/${pid}/webhooks`, { headers: { "x-admin-token": ADMIN } });
    const lj = await list.json();
    expect(lj.data.webhooks[0].url).toBe("https://example.com/hook");
    expect(lj.data.webhooks[0].secret).toBeUndefined();
  });

  test("수신거부: opt-out 유저는 발송 대상에서 제외", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sup-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const ext = "sup-user";
    const hash = idHash(ext, apiSecret);

    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `sup-tok-${Date.now()}`, platform: "web", external_id: ext, identity_hash: hash } });
    // opt-out
    const opt = await request.post("/api/v1/suppressions", { headers: { "api-key": apiKey }, data: { external_id: ext } });
    expect(opt.status()).toBe(201);
    // send + process
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "t", body: "b", type: "single", target: ext } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    // 로그의 대상 수 0 (억제됨)
    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const lj = await logs.json();
    expect(lj.data.logs[0].totalCount).toBe(0);
  });

  test("분석 통계: devices/users/messages 집계", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `stats-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const pid = cj.data.project.id as string;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `st-1-${Date.now()}`, platform: "web" } });
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `st-2-${Date.now()}`, platform: "android" } });

    const stats = await request.get(`/api/admin/projects/${pid}/stats`, { headers: { "x-admin-token": ADMIN } });
    expect(stats.status()).toBe(200);
    const sj = await stats.json();
    expect(sj.data.devices.total).toBeGreaterThanOrEqual(2);
    expect(sj.data.devices.active).toBeGreaterThanOrEqual(2);
  });

  test("In-app 인박스: 단건 발송 → 적재 → 읽음", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `inbox-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const ext = "inbox-user";
    const hash = idHash(ext, apiSecret);

    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `ib-tok-${Date.now()}`, platform: "web", external_id: ext, identity_hash: hash } });
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "인박스", body: "본문", type: "single", target: ext } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const inbox = await request.get(`/api/v1/inbox?external_id=${ext}`, { headers: { "api-key": apiKey } });
    const ij = await inbox.json();
    expect(ij.data.notifications.length).toBeGreaterThanOrEqual(1);
    expect(ij.data.unread).toBeGreaterThanOrEqual(1);

    const read = await request.post("/api/v1/inbox/read", { headers: { "api-key": apiKey }, data: { external_id: ext } });
    expect(read.status()).toBe(200);
    const inbox2 = await request.get(`/api/v1/inbox?external_id=${ext}`, { headers: { "api-key": apiKey } });
    expect((await inbox2.json()).data.unread).toBe(0);
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
