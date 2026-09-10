import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";

const ADMIN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
const TEST_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDnJCp2kQuUqKWD\nq7565oF9E4TEcbZyLpGr07/XHZ2IT9PFKJpE6qXh06r2U1cNaqnGnP3Ua1ZpZ9lz\nw/UXdLKzqou2J35+k5GCjQ6UfhXqjAkVMH9WB7SOwSW/GihtgogseoXRDeigc+wm\nwpGJLmPFALKreLTdScLlztHwI2fcYTCOIfVWdH/RlDa0cV3co9WmQBSy9wiCYMO+\nskCzZaBtiuhM/ni4213/ctoukGEIr7gap81TfgfKbgWKr24TWCuOK06BMQk/mPRd\nfKwO4plUCzNlFlQwt2xaz3FDYs56JI/YD4BC2W/NSIq86zKZGYTBrpjcGhXmN72A\nTuG9If7fAgMBAAECggEAM9+V+A4NP0up+abtlL9uiBd9UGkEvRNedeWLxEdNN25S\n5Ih8NsNCfy/1ylphyw0JFR3eiXGdbwJzdtufgagbAt9fg33Rka6klVv6zbCOUpki\n4LKFoVURXIhUZFMGh60nynOk3In2jyv0763y44qZsXi6oGjyjkcjilekHfSUNozc\nE/dREtZ7Lj5UVUzhWmjfJaADVLj2FSy5CphS+PxViLlzP+P+aiGrrskGyLWrA7cI\nXr6zoL8+AeNgo8Gd7w/2Kb9emk+gxG0YODcvJa8jLhSYaPCKLDJMvheBRsmGRkHI\noMR6umKsNmo9idKbkCI3uxgM6L5h5Hd77w/0zNdJ4QKBgQD5rZmhJcpn2VP6B1Jf\nW1SPmviDPDgoWInPz4hWbkwqwdjamrCKT8NHAEvz4Z7Rk9hDWqoegA+H48tNr+09\nOSUltOYwnQc1ngTighttQ2hAvxs+Pxb7oR/X000vNI6V2dHPx8lNIAJR354kogLG\nJWTbtHHeQHkx6Tfn213lVBCkiwKBgQDs/mkwk2VpRoyjGLxLK9hDNznENJmCakLC\nPGucaOWvyV9F/1HKPV65fIdeTHLIl4wfpBa0nTc9z1uXE+EBAp3fCh4xJbVde1LS\nng2j8MFqPpwotisDrczBShkR+pcBR9Ur7ufwvIqOoJ77TcyM/MKoH7Dbu/IGH4IF\nSoEbGY7VfQKBgQCydYX4q+VHYwxmCvOymroPRupYCyPsmpQuSB0gAghJC3MvlR+Y\nTLi8OBcRw3NcQztxsQ0lbc0sCQLYjWWZvA20LN/XYXW0ujStnedyqpqKpM4ZKMkJ\npDn5btudYQiFTUJtLFTS3o0p7hbAAljPPg0gCJLXE+hMZ3EBNUeg0fxvTwKBgAKq\nRcKPFcfeTDyVTaDGyHLRDyw+ry9BRKjshwVGRLb6W8Dswx20HPmXBeqwj2XkFmZQ\nsRSs4+8lAtGrHo+lWOMmOPqygtyfQ2os7thWH8azF4x5p/gtnyzZSXjjSYlxJluN\nHzyc0i4SbldDI7a+LO45FQMTlQAuoIawtMz6N5n9AoGBAJhbLoSHwNep2Su9BLNq\nn5DguFru9uS7bGO8+1gGrs6yHPca+RRp6inp2eez5LaJLuLuPFUHYMVYEqpIW315\ny2THQXdj4ZzKGC+viC2cvWAm5+BvYbqTTO6eMQfOWGJFuIcCxltQdcPQCgkf23kg\nPJO7Oa/jCDNIw71z/MkDZqNI\n-----END PRIVATE KEY-----";

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

    // 스키마는 맞지만 파싱 불가한 private_key → 422 (사용 불가 키가 정상 키를 덮어쓰는 것 방지)
    const badKey = await request.post(`/api/admin/projects/${pid}/firebase`, {
      headers: { "x-admin-token": ADMIN },
      data: {
        credentials: {
          type: "service_account",
          project_id: "demo-proj",
          private_key: "-----BEGIN PRIVATE KEY-----\\nnotarealkey\\n-----END PRIVATE KEY-----\\n",
          client_email: "sdk@demo-proj.iam.gserviceaccount.com",
        },
      },
    });
    expect(badKey.status()).toBe(422);

    // 유효 형태 → 200 configured (암호화 저장; 실제 FCM init 은 발송 시)
    const good = await request.post(`/api/admin/projects/${pid}/firebase`, {
      headers: { "x-admin-token": ADMIN },
      data: {
        credentials: {
          type: "service_account",
          project_id: "demo-proj",
          private_key: TEST_PRIVATE_KEY,
          client_email: "sdk@demo-proj.iam.gserviceaccount.com",
        },
      },
    });
    expect(good.status()).toBe(200);
    const gj = await good.json();
    expect(gj.data.configured).toBe(true);
    expect(gj.data.firebase_project_id).toBe("demo-proj");

    // 실제 서비스계정 JSON 형태(개행이 리터럴 \n 으로 이스케이프)도 정규화되어 200 이어야 함
    // (검증만 정규화하고 원본을 저장하던 회귀 방지)
    const escaped = await request.post(`/api/admin/projects/${pid}/firebase`, {
      headers: { "x-admin-token": ADMIN },
      data: {
        credentials: {
          type: "service_account",
          project_id: "demo-proj",
          private_key: TEST_PRIVATE_KEY.replace(/\n/g, "\\n"),
          client_email: "sdk@demo-proj.iam.gserviceaccount.com",
        },
      },
    });
    expect(escaped.status()).toBe(200);
  });

  test("Web Admin 발송: admin 토큰으로 큐잉(202) — api-secret 불필요", async ({ request }) => {
    const created = await request.post("/api/admin/projects", {
      headers: { "x-admin-token": ADMIN },
      data: { name: `adminsend-${Date.now()}` },
    });
    const pid = (await created.json()).data.project.id;

    const res = await request.post(`/api/admin/projects/${pid}/messages`, {
      headers: { "x-admin-token": ADMIN },
      data: { title: "콘솔 발송", body: "admin 세션 발송", type: "broadcast" },
    });
    expect(res.status()).toBe(202);

    // single 인데 target 없으면 422
    const bad = await request.post(`/api/admin/projects/${pid}/messages`, {
      headers: { "x-admin-token": ADMIN },
      data: { title: "x", body: "y", type: "single" },
    });
    expect(bad.status()).toBe(422);
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

    const inbox = await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${hash}`, { headers: { "api-key": apiKey } });
    const ij = await inbox.json();
    expect(ij.data.notifications.length).toBeGreaterThanOrEqual(1);
    expect(ij.data.unread).toBeGreaterThanOrEqual(1);

    // IDOR 방지: identity_hash 없으면 403
    const denied = await request.get(`/api/v1/inbox?external_id=${ext}`, { headers: { "api-key": apiKey } });
    expect(denied.status()).toBe(403);

    const read = await request.post("/api/v1/inbox/read", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: hash } });
    expect(read.status()).toBe(200);
    const inbox2 = await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${hash}`, { headers: { "api-key": apiKey } });
    expect((await inbox2.json()).data.unread).toBe(0);
  });

  test("세그먼트: 속성 규칙(plan=pro) 매칭 유저만 대상", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `seg-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    // 세그먼트 생성
    await request.post(`/api/admin/projects/${pid}/segments`, { headers: { "x-admin-token": ADMIN }, data: { name: "pro-users", rules: [{ attribute: "plan", value: "pro" }] } });

    // pro 유저 + free 유저 등록/속성
    for (const [ext, plan] of [["pro-1", "pro"], ["free-1", "free"]] as const) {
      const h = idHash(ext, apiSecret);
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `seg-${ext}-${Date.now()}`, platform: "web", external_id: ext, identity_hash: h } });
      await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: h, attributes: { plan } } });
    }

    // 세그먼트 발송 + 처리
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "s", body: "b", type: "segment", target: "pro-users" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const lj = await logs.json();
    expect(lj.data.logs[0].totalCount).toBe(1); // pro 유저 1명만
  });

  test("방해금지 시간대: quiet 구간 발송은 자동 예약", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `quiet-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    // 지금을 포함하는 quiet 윈도우 설정
    const h = new Date().getUTCHours();
    const patch = await request.patch(`/api/admin/projects/${pid}`, { headers: { "x-admin-token": ADMIN }, data: { quiet_start_hour: h, quiet_end_hour: (h + 2) % 24 } });
    expect(patch.status()).toBe(200);

    const send = await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "q", body: "b", type: "broadcast" } });
    expect((await send.json()).data.message.status).toBe("scheduled");
  });

  test("A/B: 변형별 수신자 분배 집계", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `ab-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    for (let i = 0; i < 6; i++) {
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `ab-tok-${i}-${Date.now()}`, platform: "web" } });
    }
    await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "base", body: "base", type: "broadcast", variants: [{ title: "A", body: "a" }, { title: "B", body: "b" }] },
    });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const log = (await logs.json()).data.logs[0];
    expect(Object.keys(log.variantStats)).toHaveLength(2);
    const sumSent = Object.values(log.variantStats).reduce((s: number, v: any) => s + v.sent, 0);
    expect(sumSent).toBe(log.totalCount);
    expect(log.totalCount).toBe(6);
  });

  test("카카오 알림톡: 설정 업로드 검증 + phone 저장", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `kakao-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    const bad = await request.post(`/api/admin/projects/${pid}/kakao`, { headers: { "x-admin-token": ADMIN }, data: { config: { foo: "bar" } } });
    expect(bad.status()).toBe(422);

    const good = await request.post(`/api/admin/projects/${pid}/kakao`, { headers: { "x-admin-token": ADMIN }, data: { config: { provider_url: "https://example.com/send", api_key: "K", sender_key: "S" } } });
    expect(good.status()).toBe(200);
    expect((await good.json()).data.configured).toBe(true);

    const ext = "kakao-user";
    const hash = idHash(ext, apiSecret);
    const idf = await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: hash, phone: "01012345678" } });
    expect(idf.status()).toBe(200);
    expect((await idf.json()).data.user.phone).toBe("01012345678");
  });

  test("저니: 다단계(send→wait→send) 진행", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `jny-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    await request.post(`/api/admin/projects/${pid}/journeys`, {
      headers: { "x-admin-token": ADMIN },
      data: { name: "welcome", steps: [{ type: "send", title: "J1", body: "b" }, { type: "wait", hours: 24 }, { type: "send", title: "J2", body: "b" }] },
    });

    const ext = "j-user";
    const hash = idHash(ext, apiSecret);
    const enroll = await request.post("/api/v1/journeys/enroll", { headers: { "api-key": apiKey }, data: { journey: "welcome", external_id: ext, identity_hash: hash } });
    expect(enroll.status()).toBe(201);

    const proc = (n: string) => request.post(`/api/admin/projects/${pid}/journeys/process`, { headers: { "x-admin-token": ADMIN }, data: {} }).then((r) => r.json());
    expect((await proc("1")).data.processed).toBe(1); // step0 send
    expect((await proc("2")).data.processed).toBe(1); // step1 wait
    expect((await proc("3")).data.processed).toBe(0); // wait 24h → not due

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const titles = (await logs.json()).data.logs.map((l: { title: string }) => l.title);
    expect(titles).toContain("J1");
  });

  test("검증: single 인데 target 없으면 422", async ({ request }) => {
    const { apiKey, apiSecret } = await createProject(request);
    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "single" },
    });
    expect(res.status()).toBe(422);
  });

  test("클릭 추적: 유저 귀속은 서버가 바인딩에서 해석 + 재클릭은 1회로 집계", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `click-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const ext = "click-user";
    const token = `ck-tok-${Date.now()}`;

    await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "android", external_id: ext, identity_hash: idHash(ext, apiSecret) },
    });
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "클릭", body: "본문", type: "single", target: ext },
    });
    const logId = (await send.json()).data.message.id as string;
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    // 첫 클릭 기록됨
    const first = await request.post("/api/v1/messages/click", {
      headers: { "api-key": apiKey },
      data: { log_id: logId, token, destination: "myapp://orders/1" },
    });
    expect(first.status()).toBe(202);
    expect((await first.json()).data.recorded).toBe(true);

    // 재클릭은 무시 — 클릭률이 부풀지 않아야 한다
    const again = await request.post("/api/v1/messages/click", {
      headers: { "api-key": apiKey },
      data: { log_id: logId, token },
    });
    expect((await again.json()).data.recorded).toBe(false);

    // 수신 대상이 아니었던 디바이스는 거부 — 공개 api-key 로 가짜 토큰을 등록해
    // 클릭을 무한히 찍는 경로를 막는다
    const fakeToken = `fake-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: fakeToken, platform: "android" } });
    const forged = await request.post("/api/v1/messages/click", {
      headers: { "api-key": apiKey },
      data: { log_id: logId, token: fakeToken },
    });
    expect(forged.status()).toBe(403);

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const row = (await logs.json()).data.logs.find((l: { id: string }) => l.id === logId);
    expect(row.clickCount).toBe(1);
    expect(row.clickUserCount).toBe(1); // 서버가 devices.userId 로 유저를 해석했다
    expect(row.audienceUserCount).toBe(1);
  });

  test("클릭 추적: 타 프로젝트 로그·미등록 토큰은 거부", async ({ request }) => {
    const a = await createProject(request);
    const b = await createProject(request);
    const token = `x-tok-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": a.apiKey }, data: { token, platform: "ios" } });
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": a.apiKey, "api-secret": a.apiSecret },
      data: { title: "t", body: "b", type: "broadcast" },
    });
    const logId = (await send.json()).data.message.id as string;

    // 타 테넌트의 api-key 로는 이 로그에 클릭을 심을 수 없다
    const cross = await request.post("/api/v1/messages/click", {
      headers: { "api-key": b.apiKey },
      data: { log_id: logId, token },
    });
    expect(cross.status()).toBe(404);

    // 등록되지 않은 토큰도 거부 — 익명 클릭이 통계에 섞이지 않게
    const unknown = await request.post("/api/v1/messages/click", {
      headers: { "api-key": a.apiKey },
      data: { log_id: logId, token: "never-registered" },
    });
    expect(unknown.status()).toBe(404);
  });

  test("언바인딩: external_id: null 이면 이후 클릭이 이전 계정에 귀속되지 않는다", async ({ request }) => {
    const { apiKey, apiSecret } = await createProject(request);
    const ext = "shared-device-user";
    const token = `ub-tok-${Date.now()}`;

    await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "android", external_id: ext, identity_hash: idHash(ext, apiSecret) },
    });
    // 생략은 기존 바인딩 유지
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token, platform: "android" } });
    const kept = await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token, platform: "android" } });
    expect((await kept.json()).data.device.userId).not.toBeNull();

    // 해제도 identity 증명을 요구한다 — 없으면 403
    const noProof = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "android", external_id: null },
    });
    expect(noProof.status()).toBe(403);

    // 올바른 해시가 있으면 해제
    const unbound = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "android", external_id: null, identity_hash: idHash(ext, apiSecret) },
    });
    expect((await unbound.json()).data.device.userId).toBeNull();
  });

  test("토큰 검사: dry-run 은 크레덴셜 없으면 skip, 인증·레이트리밋 적용", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `tok-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const pid = cj.data.project.id as string;

    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `hc-${Date.now()}`, platform: "android" } });

    // Firebase 미설정 프로젝트는 검사 자체를 못하므로 skipped — 조용히 0건 성공으로 위장하지 않는다
    const res = await request.post(`/api/admin/projects/${pid}/devices/check`, { headers: { "x-admin-token": ADMIN }, data: {} });
    expect(res.status()).toBe(200);
    const body = (await res.json()).data;
    expect(body.skipped).toBe(true);
    expect(body.deactivated).toBe(0);

    // 인증 없이는 거부 — Origin 없는 상태변경은 CSRF 검사에서 먼저 막힌다(403)
    const anon = await request.post(`/api/admin/projects/${pid}/devices/check`, { data: {} });
    expect(anon.status()).toBe(403);

    // 레이트리밋 — partial 이어받기를 막지 않을 만큼 여유가 있지만 상한은 있다
    let limited = 0;
    for (let i = 0; i < 35; i++) {
      const r = await request.post(`/api/admin/projects/${pid}/devices/check`, { headers: { "x-admin-token": ADMIN }, data: {} });
      if (r.status() === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("야간 스윕: min_interval_hours 로 하루 1회만 클레임된다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sweep-${Date.now()}` } });
    const pid = (await created.json()).data.project.id as string;
    const check = (h: number) =>
      request.post(`/api/admin/projects/${pid}/devices/check?min_interval_hours=${h}`, { headers: { "x-admin-token": ADMIN }, data: {} });

    // 첫 호출은 클레임 성공 (크레덴셜이 없어 skipped 지만 클레임은 소비된다)
    const first = await check(20);
    expect(first.status()).toBe(200);
    expect((await first.json()).data.alreadyChecked).toBeUndefined();

    // 같은 창에서 재호출·다중 워커는 건너뛴다
    const second = await check(20);
    expect((await second.json()).data.alreadyChecked).toBe(true);

    // 0 이면 항상 재검사 — 콘솔에서 수동 실행하는 경우.
    // 분당 2회 제한이 있으므로 별도 프로젝트로 확인한다.
    const other = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sweep2-${Date.now()}` } });
    const pid2 = (await other.json()).data.project.id as string;
    await request.post(`/api/admin/projects/${pid2}/devices/check?min_interval_hours=20`, { headers: { "x-admin-token": ADMIN }, data: {} });
    const forced = await request.post(`/api/admin/projects/${pid2}/devices/check?min_interval_hours=0`, { headers: { "x-admin-token": ADMIN }, data: {} });
    expect(forced.status()).toBe(200);
    expect((await forced.json()).data.alreadyChecked).toBeUndefined();

    const bad = await request.post(`/api/admin/projects/${pid2}/devices/check?min_interval_hours=-1`, { headers: { "x-admin-token": ADMIN }, data: {} });
    expect(bad.status()).toBe(422);
  });

  test("로그 분리: type 필터 + 읽은 사람 목록(타 테넌트 차단)", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `rd-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const admin = { "x-admin-token": ADMIN };

    const ext = "reader-1";
    const token = `rd-tok-${Date.now()}`;
    await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "android", external_id: ext, identity_hash: idHash(ext, apiSecret) },
    });
    await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", token } });

    const priv = { "api-key": apiKey, "api-secret": apiSecret };
    const topicSend = await request.post("/api/v1/messages", { headers: priv, data: { title: "토픽", body: "b", type: "topic", target: "news" } });
    const topicLog = (await topicSend.json()).data.message.id as string;
    await request.post("/api/v1/messages", { headers: priv, data: { title: "단건", body: "b", type: "single", target: ext } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });

    // type 필터가 실제로 갈라놓는다
    const topics = await request.get(`/api/admin/projects/${pid}/logs?type=topic`, { headers: admin });
    const tl = (await topics.json()).data.logs;
    expect(tl).toHaveLength(1);
    expect(tl[0]).toMatchObject({ type: "topic", target: "news" });

    const singles = await request.get(`/api/admin/projects/${pid}/logs?type=single`, { headers: admin });
    const sl = (await singles.json()).data.logs;
    expect(sl).toHaveLength(1);
    expect(sl[0].type).toBe("single");

    // 클릭 전에는 읽은 사람이 없다
    const before = await request.get(`/api/admin/projects/${pid}/logs/${topicLog}/readers`, { headers: admin });
    expect((await before.json()).data.readers).toHaveLength(0);

    await request.post("/api/v1/messages/click", {
      headers: { "api-key": apiKey },
      data: { log_id: topicLog, token, destination: "myapp://x" },
    });

    const after = await request.get(`/api/admin/projects/${pid}/logs/${topicLog}/readers`, { headers: admin });
    const rj = (await after.json()).data;
    expect(rj.readers).toHaveLength(1);
    expect(rj.readers[0]).toMatchObject({ externalId: ext, platform: "android", destination: "myapp://x" });
    expect(rj.log).toMatchObject({ type: "topic", clickUserCount: 1 });

    // 타 프로젝트 경로로는 이 발송의 수신자 명단을 볼 수 없다
    const other = await request.post("/api/admin/projects", { headers: admin, data: { name: `rd2-${Date.now()}` } });
    const otherPid = (await other.json()).data.project.id as string;
    const cross = await request.get(`/api/admin/projects/${otherPid}/logs/${topicLog}/readers`, { headers: admin });
    expect(cross.status()).toBe(404);
  });

  test("접속 통계: ping 이 일별 롤업을 만들고 같은 날 재호출은 opens 만 올린다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `act-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const admin = { "x-admin-token": ADMIN };
    const ext = "active-user";
    const token = `act-tok-${Date.now()}`;

    // 등록 자체가 접속 1회로 잡힌다
    await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token, platform: "ios", external_id: ext, identity_hash: idHash(ext, apiSecret) },
    });

    const first = await request.get(`/api/admin/projects/${pid}/activity`, { headers: admin });
    const f = (await first.json()).data;
    expect(f.dau).toMatchObject({ devices: 1, users: 1 });
    expect(f.mau.devices).toBe(1);
    expect(f.opens).toBe(1);
    expect(f.platforms).toMatchObject({ ios: 1 });
    // DAU/MAU 는 1/1
    expect(f.stickiness).toBe(1);

    // 같은 날 ping 두 번 → 디바이스는 그대로, opens 만 증가
    for (let i = 0; i < 2; i++) {
      const p = await request.post("/api/v1/devices/ping", { headers: { "api-key": apiKey }, data: { token } });
      expect(p.status()).toBe(202);
    }
    const second = await request.get(`/api/admin/projects/${pid}/activity`, { headers: admin });
    const sJson = (await second.json()).data;
    expect(sJson.dau.devices).toBe(1);
    expect(sJson.opens).toBe(3);

    // 버킷은 요청 범위만큼 빠짐없이 채워진다
    expect(sJson.buckets).toHaveLength(30);
    expect(sJson.buckets.at(-1)).toMatchObject({ devices: 1, users: 1, opens: 3 });

    // 미등록 토큰은 거부 — 아무 토큰이나 DAU 를 만들 수 없게
    const unknown = await request.post("/api/v1/devices/ping", { headers: { "api-key": apiKey }, data: { token: "nope" } });
    expect(unknown.status()).toBe(404);

    // 범위 밖 값은 기본(30d)으로 떨어진다
    const bad = await request.get(`/api/admin/projects/${pid}/activity?range=constructor`, { headers: admin });
    expect((await bad.json()).data.range).toBe("30d");
  });
});
