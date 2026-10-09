import { test, expect, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./env";

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

  test("토큰 교체: 기기 id·구독이 보존되고 행이 늘지 않는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `rot-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const ext = "rot-user";
    const hash = idHash(ext, apiSecret);
    const oldTok = `rot-old-${Date.now()}`;
    const newTok = `rot-new-${Date.now()}`;

    const reg = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token: oldTok, platform: "android", external_id: ext, identity_hash: hash },
    });
    const deviceId = (await reg.json()).data.device.id as string;
    await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", token: oldTok } });

    // 증명 없이는 교체되지 않는다. 다만 403 으로 갈라주면 "그 토큰은 존재하고
    // 유저에 묶여 있다"가 드러나므로, 모르는 토큰과 **같은 응답**을 준다.
    const forged = await request.post("/api/v1/devices/rotate", { headers: { "api-key": apiKey }, data: { old_token: oldTok, new_token: newTok } });
    expect(forged.status()).toBe(202);
    expect((await forged.json()).data.rotated).toBe(false);

    // 없는 토큰도 구분되지 않아야 한다
    const unknown = await request.post("/api/v1/devices/rotate", { headers: { "api-key": apiKey }, data: { old_token: "no-such-token", new_token: newTok } });
    expect(unknown.status()).toBe(forged.status());
    expect((await unknown.json()).data.rotated).toBe(false);

    const rot = await request.post("/api/v1/devices/rotate", {
      headers: { "api-key": apiKey },
      data: { old_token: oldTok, new_token: newTok, identity_hash: hash },
    });
    expect(rot.status()).toBe(202);
    const rj = await rot.json();
    expect(rj.data.rotated).toBe(true);
    // 같은 행을 갱신했으므로 기기 id 가 유지된다 — 구독·클릭 이력이 그대로 살아 있다
    expect(rj.data.device_id).toBe(deviceId);

    // 행이 늘지 않았는지: 활성 기기는 여전히 1대
    const list = await request.get(`/api/admin/projects/${pid}/audience/devices`, { headers: { "x-admin-token": ADMIN } });
    const devices = (await list.json()).data.devices as Array<{ id: string; isActive: boolean }>;
    expect(devices.filter((d) => d.isActive).length).toBe(1);
    expect(devices[0].id).toBe(deviceId);

    // 토픽 발송이 교체된 기기에 그대로 잡힌다
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "t", body: "b", type: "topic", target: "news" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    expect((await logs.json()).data.logs[0].totalCount).toBe(1);
  });

  test("토큰 교체: 수신거부가 새 토큰으로 따라간다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `rotsup-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const oldTok = `sup-old-${Date.now()}`;
    const newTok = `sup-new-${Date.now()}`;

    // 익명 기기 — 증명 없이 교체 가능한 경로
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: oldTok, platform: "android" } });
    await request.post("/api/v1/suppressions", { headers: { "api-key": apiKey }, data: { token: oldTok, reason: "opt_out" } });

    const rot = await request.post("/api/v1/devices/rotate", { headers: { "api-key": apiKey }, data: { old_token: oldTok, new_token: newTok } });
    expect((await rot.json()).data.rotated).toBe(true);

    // 수신거부가 따라가지 않으면 차단해 둔 기기에 다시 발송된다
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "t", body: "b", type: "broadcast" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    expect((await logs.json()).data.logs[0].totalCount).toBe(0);
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
    // 증명 없는 external_id 수신거부는 거부된다 — 공개 api-key 만으로 남의 수신을 끊지 못한다
    const forged = await request.post("/api/v1/suppressions", { headers: { "api-key": apiKey }, data: { external_id: ext } });
    expect(forged.status()).toBe(403);

    // opt-out
    const opt = await request.post("/api/v1/suppressions", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: hash } });
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

  test("규칙식 그룹: 속성 규칙(plan=pro) 매칭 유저만 대상", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `seg-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    // 규칙식 대상 그룹 생성
    const mk = await request.post(`/api/admin/projects/${pid}/audience/topics`, { headers: { "x-admin-token": ADMIN }, data: { name: "pro-users", rules: [{ attribute: "plan", value: "pro" }] } });
    expect(mk.status()).toBe(201);

    // pro 유저 + free 유저 등록/속성
    for (const [ext, plan] of [["pro-1", "pro"], ["free-1", "free"]] as const) {
      const h = idHash(ext, apiSecret);
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `seg-${ext}-${Date.now()}`, platform: "web", external_id: ext, identity_hash: h } });
      await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: h, attributes: { plan } } });
    }

    // 규칙식 그룹은 구독으로 넣고 뺄 수 없다 — 명단이 자동으로 정해지므로
    const sub = await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "pro-users", external_id: "free-1", identity_hash: idHash("free-1", apiSecret) } });
    expect(sub.status()).toBe(409);

    // 그룹 발송 + 처리
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "s", body: "b", type: "topic", target: "pro-users" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const lj = await logs.json();
    expect(lj.data.logs[0].totalCount).toBe(1); // pro 유저 1명만
  });

  test("구독식 그룹: external_id 로 구독하면 그 사람의 기기가 전부 들어간다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sub-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    const ext = "multi-device";
    const h = idHash(ext, apiSecret);
    const stamp = Date.now();
    for (const suffix of ["a", "b"]) {
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `sub-${suffix}-${stamp}`, platform: "web", external_id: ext, identity_hash: h } });
    }
    await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: h } });

    // 증명 없는 external_id 구독은 거부된다 — 공개 api-key 만으로 남의 기기를 넣고 빼지 못한다
    const forged = await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", external_id: ext } });
    expect(forged.status()).toBe(403);
    const forgedUnsub = await request.post("/api/v1/topics/unsubscribe", { headers: { "api-key": apiKey }, data: { topic: "news", external_id: ext, identity_hash: "bad" } });
    expect(forgedUnsub.status()).toBe(403);

    // 사람 단위 구독 — 기기 2대가 한 번에 들어간다
    const sub = await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", external_id: ext, identity_hash: h } });
    expect(sub.status()).toBe(200);
    expect((await sub.json()).data.added).toBe(2);

    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "s", body: "b", type: "topic", target: "news" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });
    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    expect((await logs.json()).data.logs[0].totalCount).toBe(2);

    // 해지도 사람 단위 — 기기 2대가 한 번에 빠진다
    const unsub = await request.post("/api/v1/topics/unsubscribe", { headers: { "api-key": apiKey }, data: { topic: "news", external_id: ext, identity_hash: h } });
    expect(unsub.status()).toBe(200);
    expect((await unsub.json()).data.removed).toBe(2);

    // 없는 그룹에서 빼 달라는 요청은 그룹을 만들지 않는다
    const missing = await request.post("/api/v1/topics/unsubscribe", { headers: { "api-key": apiKey }, data: { topic: "nope", external_id: ext, identity_hash: h } });
    expect(missing.status()).toBe(404);
  });

  test("다중 발송: 고른 사람들의 기기에만 가고, 없는 아이디는 건너뛴다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `multi-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const stamp = Date.now();

    // a: 기기 2대, b: 1대, c: 목록에 없음(받으면 안 된다)
    for (const [ext, n] of [["m-a", 2], ["m-b", 1], ["m-c", 1]] as const) {
      const h = idHash(ext, apiSecret);
      for (let i = 0; i < n; i++) {
        await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `m-${ext}-${i}-${stamp}`, platform: "web", external_id: ext, identity_hash: h } });
      }
    }

    const missing = await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { title: "t", body: "b", type: "multi" } });
    expect(missing.status()).toBe(422);

    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "multi", targets: ["m-a", "m-b", "m-a", "nobody"] },
    });
    expect(send.status()).toBe(202);
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const logs = await request.get(`/api/admin/projects/${pid}/logs?type=single`, { headers: { "x-admin-token": ADMIN } });
    const log = (await logs.json()).data.logs[0];
    // 중복 m-a 는 한 번, nobody 는 건너뛰고, m-c 는 목록에 없으므로 3대
    expect(log.totalCount).toBe(3);

    // 목록에 있던 사람만 인박스를 받는다
    const inboxOf = async (ext: string) =>
      (await (await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${idHash(ext, apiSecret)}`, { headers: { "api-key": apiKey } })).json()).data.notifications.length;
    expect(await inboxOf("m-a")).toBe(1);
    expect(await inboxOf("m-c")).toBe(0);
  });

  test("치환: {{속성}} 은 받는 사람마다 바뀌고, 값이 없으면 기본값", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `tpl-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    for (const [ext, attrs] of [["t-named", { name: "민지" }], ["t-anon", {}]] as const) {
      const h = idHash(ext, apiSecret);
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `tpl-${ext}-${Date.now()}`, platform: "web", external_id: ext, identity_hash: h } });
      await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: h, attributes: attrs } });
    }

    await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "{{name|고객}}님", body: "아이디 {{external_id}}", type: "multi", targets: ["t-named", "t-anon"] },
    });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const first = async (ext: string) =>
      (await (await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${idHash(ext, apiSecret)}`, { headers: { "api-key": apiKey } })).json()).data.notifications[0];
    expect(await first("t-named")).toMatchObject({ title: "민지님", body: "아이디 t-named" });
    expect(await first("t-anon")).toMatchObject({ title: "고객님", body: "아이디 t-anon" });
  });

  test("템플릿: 생성·수정·삭제 + 예약 키·중복 이름·타 프로젝트 차단", async ({ request }) => {
    const admin = { "x-admin-token": ADMIN };
    const mk = async (name: string) =>
      (await (await request.post("/api/admin/projects", { headers: admin, data: { name } })).json()).data.project.id as string;
    const pid = await mk(`tpl-crud-${Date.now()}`);
    const other = await mk(`tpl-other-${Date.now()}`);
    const base = `/api/admin/projects/${pid}/templates`;

    const created = await request.post(base, {
      headers: admin,
      data: { name: "주문 도착", title: "{{name|고객}}님", body: "도착했어요", deep_link: "myapp://order", fields: [{ key: "order_id", required: true }, { key: "screen", default: "order" }] },
    });
    expect(created.status()).toBe(201);
    const tid = (await created.json()).data.template.id as string;

    // 푸시가 이미 쓰는 키는 필드로 만들 수 없다
    const reserved = await request.post(base, { headers: admin, data: { name: "x", title: "", body: "", fields: [{ key: "notikit_log_id" }] } });
    expect(reserved.status()).toBe(422);
    const dup = await request.post(base, { headers: admin, data: { name: "주문 도착", title: "", body: "" } });
    expect(dup.status()).toBe(409);

    const put = await request.put(`${base}/${tid}`, { headers: admin, data: { name: "주문 도착 v2", title: "t", body: "b", fields: [] } });
    expect(put.status()).toBe(200);
    expect((await put.json()).data.template).toMatchObject({ name: "주문 도착 v2", fields: [], deepLink: null });

    // 다른 프로젝트 경로로는 보이지도 지워지지도 않는다
    expect((await request.get(`/api/admin/projects/${other}/templates/${tid}`, { headers: admin })).status()).toBe(404);
    expect((await request.delete(`/api/admin/projects/${other}/templates/${tid}`, { headers: admin })).status()).toBe(404);

    const list = await request.get(base, { headers: admin });
    expect((await list.json()).data.templates).toHaveLength(1);
    expect((await request.delete(`${base}/${tid}`, { headers: admin })).status()).toBe(200);
  });

  test("템플릿 발송(API): 이름으로 부르면 내용·필드가 채워지고, 잘못된 입력은 거절", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `tpl-api-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const send = (data: Record<string, unknown>) =>
      request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { type: "single", target: "tpl-u", ...data } });

    const ext = "tpl-u";
    const h = idHash(ext, apiSecret);
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `tpl-api-${Date.now()}`, platform: "web", external_id: ext, identity_hash: h } });
    await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: h, attributes: { name: "민지" } } });
    await request.post(`/api/admin/projects/${pid}/templates`, {
      headers: { "x-admin-token": ADMIN },
      data: { name: "주문 도착", title: "{{name|고객}}님, 주문 도착", body: "확인해 보세요", deep_link: "myapp://orders", fields: [{ key: "order_id", required: true }, { key: "screen", default: "order" }] },
    });

    expect((await send({ template: "없는 템플릿" })).status()).toBe(404);
    expect((await send({ template: "주문 도착" })).status()).toBe(422); // 필수 order_id 누락
    expect((await send({ template: "주문 도착", fields: { order_id: "A", orderId: "B" } })).status()).toBe(422); // 오타 키
    expect((await send({ title: "t", body: "b", fields: { order_id: "A" } })).status()).toBe(422); // 템플릿 없이 fields
    expect((await send({})).status()).toBe(422); // 제목·본문도 템플릿도 없음

    expect((await send({ template: "주문 도착", fields: { order_id: "A-1024" } })).status()).toBe(202);
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const inbox = await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${h}`, { headers: { "api-key": apiKey } });
    expect((await inbox.json()).data.notifications[0]).toMatchObject({
      title: "민지님, 주문 도착",
      body: "확인해 보세요",
      deepLink: "myapp://orders",
      data: { order_id: "A-1024", screen: "order" },
    });
  });

  test("이름 치환: identify 의 name 이 {{name}} 이 되고, 이름으로 검색된다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `이름앱-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const appName = cj.data.project.name as string;

    const users = [
      { ext: "nm-a", body: { name: "김민지", timezone: "Asia/Seoul", locale: "ko" } },
      // 예전 방식(attributes.name)도 계속 쓰인다
      { ext: "nm-b", body: { attributes: { name: "도윤" } } },
      { ext: "nm-c", body: {} },
    ];
    for (const u of users) {
      const h = idHash(u.ext, apiSecret);
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `nm-${u.ext}-${Date.now()}`, platform: "web", external_id: u.ext, identity_hash: h } });
      const r = await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: u.ext, identity_hash: h, ...u.body } });
      expect(r.ok()).toBeTruthy();
    }

    await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { type: "multi", targets: ["nm-a", "nm-b", "nm-c"], title: "{{name|고객}}님", body: "[{{app_name}}] {{weekday}}" },
    });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    const first = async (ext: string) =>
      (await (await request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${idHash(ext, apiSecret)}`, { headers: { "api-key": apiKey } })).json()).data.notifications[0];
    expect((await first("nm-a")).title).toBe("김민지님");
    expect((await first("nm-b")).title).toBe("도윤님");
    expect((await first("nm-c")).title).toBe("고객님");
    expect((await first("nm-a")).body).toMatch(new RegExp(`^\\[${appName}\\] .+요일$`));

    // 콘솔 사용자 검색은 이름으로도 찾는다
    const found = await request.get(`/api/admin/projects/${pid}/audience/users?q=${encodeURIComponent("민지")}`, { headers: { "x-admin-token": ADMIN } });
    const fu = (await found.json()).data.users;
    expect(fu.map((u: { externalId: string }) => u.externalId)).toEqual(["nm-a"]);
    expect(fu[0].name).toBe("김민지");

    // name: null 이면 지운다
    await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: "nm-a", identity_hash: idHash("nm-a", apiSecret), name: null } });
    const after = await request.get(`/api/admin/projects/${pid}/audience/users?q=nm-a`, { headers: { "x-admin-token": ADMIN } });
    expect((await after.json()).data.users[0].name).toBeNull();
  });

  test("user_id: 새 이름으로 모든 API 가 동작하고, 예전 external_id 와 같은 사람을 가리킨다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `uid-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const uid = "uid-1";
    const h = idHash(uid, apiSecret);

    // 등록·식별은 user_id 로
    expect((await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `uid-tok-${Date.now()}`, platform: "web", user_id: uid, identity_hash: h } })).status()).toBe(201);
    expect((await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { user_id: uid, identity_hash: h, name: "민지" } })).ok()).toBeTruthy();
    // 구독은 예전 이름 external_id 로 — 같은 사람이어야 한다
    const sub = await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", external_id: uid, identity_hash: h } });
    expect((await sub.json()).data.added).toBe(1);

    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { type: "topic", target: "news", title: "{{name}} {{user_id}}", body: "b" } });
    await request.post("/api/v1/messages", { headers: { "api-key": apiKey, "api-secret": apiSecret }, data: { type: "single", target: uid, title: "t", body: "{{external_id}}" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    // 인박스는 쿼리스트링 user_id 로
    const inbox = await request.get(`/api/v1/inbox?user_id=${uid}&identity_hash=${h}`, { headers: { "api-key": apiKey } });
    const bodies = (await inbox.json()).data.notifications.map((n: { title: string; body: string }) => `${n.title}|${n.body}`).sort();
    expect(bodies).toEqual(["t|uid-1"]);

    // 둘 다 보내면 user_id 가 이긴다
    const both = await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { user_id: uid, external_id: "someone-else", identity_hash: h } });
    expect((await both.json()).data.user.externalId).toBe(uid);

    // 오류 메시지도 새 이름으로
    const bad = await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", user_id: uid } });
    expect(bad.status()).toBe(403);
    expect((await bad.json()).error).toContain("user_id");
  });

  test("리뷰 수정: attributes.name 갱신·테스트 발송 방해금지 예외·순위에서 테스트 제외", async ({ request }) => {
    const admin = { "x-admin-token": ADMIN };
    const created = await request.post("/api/admin/projects", { headers: admin, data: { name: `rv-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const uid = "rv-1";
    const h = idHash(uid, apiSecret);
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `rv-${Date.now()}`, platform: "web", user_id: uid, identity_hash: h } });

    // 예전 방식(attributes.name)으로만 보내도 이름 칸이 따라온다
    await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { user_id: uid, identity_hash: h, attributes: { name: "옛이름" } } });
    await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { user_id: uid, identity_hash: h, attributes: { name: "새이름" } } });
    const users = await request.get(`/api/admin/projects/${pid}/audience/users?q=${uid}`, { headers: admin });
    expect((await users.json()).data.users[0].name).toBe("새이름");

    // 하루 종일 방해금지로 설정해도 테스트 발송은 바로 나간다(예약되지 않는다)
    await request.patch(`/api/admin/projects/${pid}`, { headers: admin, data: { quiet_start_hour: 0, quiet_end_hour: 23 } });
    const test = await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { type: "single", target: uid, title: "t", body: "b", test: true } });
    const tj = await test.json();
    expect(tj.meta?.scheduled ?? false).toBe(false);
    expect(tj.data.message.status).toBe("queued");
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });

    // 발송 순위에는 테스트 발송이 나오지 않는다
    const ranked = await request.get(`/api/admin/projects/${pid}/logs?sort=readRate&limit=20`, { headers: admin });
    expect((await ranked.json()).data.logs.some((l: { isTest: boolean }) => l.isTest)).toBe(false);
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

  test("identify: phone 은 저장하되 응답에 싣지 않는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `phone-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;

    const ext = "phone-user";
    const hash = idHash(ext, apiSecret);
    const idf = await request.post("/api/v1/users/identify", { headers: { "api-key": apiKey }, data: { external_id: ext, identity_hash: hash, phone: "01012345678" } });
    expect(idf.status()).toBe(200);
    // identify 는 PII 를 응답에 싣지 않는다 — 저장 여부는 DB 로 본다
    expect((await idf.json()).data.user).not.toHaveProperty("phone");
    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const [u] = await sql`select phone from push_users where external_id = ${ext} and project_id = ${pid}`;
      expect(u.phone).toBe("01012345678");
    } finally {
      await sql.end();
    }
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
    await request.post("/api/v1/messages", { headers: priv, data: { title: "전체", body: "b", type: "broadcast" } });
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });

    // type 필터가 실제로 갈라놓는다 — 전체 발송은 "토픽·전체" 쪽에 나온다(전에는 어느 목록에도 없었다)
    const topics = await request.get(`/api/admin/projects/${pid}/logs?type=topic`, { headers: admin });
    const tl = (await topics.json()).data.logs;
    expect(tl.map((l: { type: string }) => l.type).sort()).toEqual(["broadcast", "topic"]);
    expect(tl.find((l: { type: string }) => l.type === "topic")).toMatchObject({ target: "news" });

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

    // 미등록 토큰은 기록되지 않는다. 상태코드는 202 로 통일 — 404 로 갈라주면
    // 공개 api-key 만으로 토큰 등록 여부를 확인하는 오라클이 된다.
    const unknown = await request.post("/api/v1/devices/ping", { headers: { "api-key": apiKey }, data: { token: "nope" } });
    expect(unknown.status()).toBe(202);
    expect((await unknown.json()).data.recorded).toBe(false);

    // 범위 밖 값은 기본(30d)으로 떨어진다
    const bad = await request.get(`/api/admin/projects/${pid}/activity?range=constructor`, { headers: admin });
    expect((await bad.json()).data.range).toBe("30d");
  });

  test("커서 페이징: 같은 시각 행이 누락되지 않는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `cur-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const admin = { "x-admin-token": ADMIN };

    // 디바이스 60대 → 무효 토큰 정리와 같은 형태로 한 번에 삭제 이벤트 적재
    for (let i = 0; i < 60; i++) {
      await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `cur-${i}-${Date.now()}`, platform: "android" } });
    }
    await request.post(`/api/admin/projects/${pid}/audience/suppressions`, { headers: admin, data: { external_id: "x", reason: "manual" } });

    // 이벤트를 만들 수 없으므로 디바이스 목록으로 커서를 검증한다(같은 원리)
    const seen = new Set<string>();
    let cursor: { ts: string; id: string } | null = null;
    for (let page = 0; page < 10; page++) {
      const q = cursor ? `?before=${encodeURIComponent(cursor.ts)}&before_id=${encodeURIComponent(cursor.id)}` : "";
      const r = await request.get(`/api/admin/projects/${pid}/audience/devices${q}`, { headers: admin });
      const d = (await r.json()).data;
      d.devices.forEach((x: { id: string }) => seen.add(x.id));
      if (!d.next) break;
      cursor = d.next;
    }
    // 전부 조회돼야 한다 — 타임스탬프 단독 커서였다면 동시각 행이 스킵됐다
    expect(seen.size).toBe(60);

    // 커서는 (시각, id) 복합이라 id 없이 주면 무시된다(첫 페이지로 취급)
    const noId = await request.get(`/api/admin/projects/${pid}/audience/devices?before=2020-01-01T00:00:00.000000Z`, { headers: admin });
    expect((await noId.json()).data.devices.length).toBeGreaterThan(0);
  });

  test("핑: 모르는 토큰도 202 (존재 오라클 없음), 비활성은 집계 안 함", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `ping-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const token = `ping-tok-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token, platform: "ios" } });

    const known = await request.post("/api/v1/devices/ping", { headers: { "api-key": apiKey }, data: { token } });
    const unknown = await request.post("/api/v1/devices/ping", { headers: { "api-key": apiKey }, data: { token: "no-such-token" } });
    // 두 경우의 상태코드가 같아야 등록 여부를 알아낼 수 없다
    expect(known.status()).toBe(202);
    expect(unknown.status()).toBe(202);
    expect((await known.json()).data.recorded).toBe(true);
    expect((await unknown.json()).data.recorded).toBe(false);

    // 모르는 토큰은 통계에 잡히지 않는다
    const act = await request.get(`/api/admin/projects/${pid}/activity`, { headers: { "x-admin-token": ADMIN } });
    expect((await act.json()).data.dau.devices).toBe(1);
  });

  test("참여 심화: 히트맵 격자·지연 구간·피크가 데이터와 일치", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `deep-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const admin = { "x-admin-token": ADMIN };

    // 클릭이 없어도 격자는 7×24 로 채워져야 한다(빈 칸 생략 시 격자가 어긋난다)
    const empty = await request.get(`/api/admin/projects/${pid}/engagement`, { headers: admin });
    const ej = (await empty.json()).data;
    expect(ej.heatmap).toHaveLength(7);
    expect(ej.heatmap[0]).toHaveLength(24);
    expect(ej.heatmap.flat().every((v: number) => v === 0)).toBe(true);
    // 클릭이 없으면 피크는 존재하지 않는다 — 0시로 위장하면 안 된다
    expect(ej.peak).toBeNull();
    expect(ej.latencyAvgSeconds).toBeNull();

    // 범위 밖 값은 기본(30d)으로 떨어진다
    const bad = await request.get(`/api/admin/projects/${pid}/engagement?range=constructor`, { headers: admin });
    expect((await bad.json()).data.range).toBe("30d");
  });

  test("리텐션: 아직 오지 않은 날짜는 0% 가 아니라 null", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `ret-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;

    // 오늘 설치된 디바이스 하나 → 코호트 크기 1
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `ret-${Date.now()}`, platform: "ios" } });

    const r = await request.get(`/api/admin/projects/${pid}/retention`, { headers: { "x-admin-token": ADMIN } });
    const d = (await r.json()).data;
    expect(d.cohorts).toHaveLength(1);
    expect(d.cohorts[0].size).toBe(1);
    // D1 부터 전부 미래 → 관측 불가
    for (const p of d.cohorts[0].points) {
      expect(p.rate).toBeNull();
      expect(p.retained).toBeNull();
    }
    // 관측 가능한 코호트가 없으므로 요약도 null
    expect(d.summary.every((s: { rate: number | null }) => s.rate === null)).toBe(true);
  });

  test("클릭 자격: 발송 이후 등록한 기기는 broadcast 도 차단", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `bc-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;

    // 발송 전에 존재하던 기기
    const early = `bc-early-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: early, platform: "android" } });

    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "전체", body: "b", type: "broadcast" },
    });
    const logId = (await send.json()).data.message.id as string;
    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: { "x-admin-token": ADMIN }, data: {} });

    // 발송 이후에 등록한 기기 — 이 발송을 받을 수 없었다
    const late = `bc-late-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: late, platform: "android" } });

    const okClick = await request.post("/api/v1/messages/click", { headers: { "api-key": apiKey }, data: { log_id: logId, token: early } });
    expect(okClick.status()).toBe(202);
    expect((await okClick.json()).data.recorded).toBe(true);

    // 과거 발송을 소급해서 클릭하는 경로가 막혀야 한다
    const lateClick = await request.post("/api/v1/messages/click", { headers: { "api-key": apiKey }, data: { log_id: logId, token: late } });
    expect(lateClick.status()).toBe(403);

    const logs = await request.get(`/api/admin/projects/${pid}/logs`, { headers: { "x-admin-token": ADMIN } });
    const row = (await logs.json()).data.logs.find((l: { id: string }) => l.id === logId);
    expect(row.clickCount).toBe(1);
  });
});

test.describe("발송 data 예약 키 · 참여 순위 기간", () => {
  test("data 에 예약 키가 오면 422 — 직접·콘솔·템플릿 경유 모두", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `reserved-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const sdk = { "api-key": apiKey, "api-secret": apiSecret };
    const admin = { "x-admin-token": ADMIN };

    await request.post(`/api/admin/projects/${pid}/templates`, {
      headers: admin,
      data: { name: "예약키", title: "t", body: "b", fields: [{ key: "order_id" }] },
    });

    for (const data of [{ notikit_log_id: "x" }, { deep_link: "x" }, { "google.x": "1" }]) {
      const direct = await request.post("/api/v1/messages", { headers: sdk, data: { type: "broadcast", title: "t", body: "b", data } });
      expect(direct.status()).toBe(422);
      expect((await direct.json()).error).toBe(`data key is reserved: ${Object.keys(data)[0]}`);

      const viaConsole = await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { type: "broadcast", title: "t", body: "b", data } });
      expect(viaConsole.status()).toBe(422);

      const viaTemplate = await request.post("/api/v1/messages", {
        headers: sdk,
        data: { type: "broadcast", template: "예약키", fields: { order_id: "1" }, data },
      });
      expect(viaTemplate.status()).toBe(422);
    }

    expect((await request.post("/api/v1/messages", { headers: sdk, data: { type: "broadcast", title: "t", body: "b", data: { order_id: "1" } } })).status()).toBe(202);
  });

  test("참여 순위(sort=readRate)는 기간 안 발송만 읽음률 순으로 준다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `ranked-${Date.now()}` } });
    const pid = (await created.json()).data.project.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const insert = (title: string, hoursAgo: number, audience: number, clicks: number) =>
        sql`insert into push_logs (project_id, type, title, body, status, audience_user_count, click_user_count, created_at)
            values (${pid}, 'broadcast', ${title}, 'b', 'completed', ${audience}, ${clicks}, now() - make_interval(hours => ${hoursAgo}))`;
      await insert("in-low", 1, 10, 2);
      await insert("in-high", 2, 10, 8);
      await insert("in-no-audience", 3, 0, 0);
      await insert("out-of-range", 24 * 10, 10, 10);
    } finally {
      await sql.end();
    }

    const rank = async (hours: number) => {
      const now = Date.now();
      const q = new URLSearchParams({
        sort: "readRate",
        limit: "20",
        from: new Date(now - hours * 3_600_000).toISOString(),
        to: new Date(now + 60_000).toISOString(),
      });
      const res = await request.get(`/api/admin/projects/${pid}/logs?${q}`, { headers: { "x-admin-token": ADMIN } });
      expect(res.status()).toBe(200);
      return ((await res.json()).data.logs as Array<{ title: string }>).map((l) => l.title);
    };

    expect(await rank(24)).toEqual(["in-high", "in-low"]);
    expect(await rank(24 * 30)).toEqual(["out-of-range", "in-high", "in-low"]);
  });

  test("도달 인원 추정: 실제 발송의 대상 수와 같다(single·multi·topic·broadcast)", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `est-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const admin = { "x-admin-token": ADMIN };
    const stamp = Date.now();

    // e-a: iOS + Android, e-b: 웹, 익명 Android 1대. news 토픽 = e-a 의 iOS + 익명
    const reg = async (token: string, platform: string, ext?: string) =>
      request.post("/api/v1/devices", {
        headers: { "api-key": apiKey },
        data: ext ? { token, platform, external_id: ext, identity_hash: idHash(ext, apiSecret) } : { token, platform },
      });
    const aIos = `est-a-ios-${stamp}`;
    const anon = `est-anon-${stamp}`;
    await reg(aIos, "ios", "e-a");
    await reg(`est-a-and-${stamp}`, "android", "e-a");
    await reg(`est-b-web-${stamp}`, "web", "e-b");
    await reg(anon, "android");
    for (const token of [aIos, anon]) {
      await request.post("/api/v1/topics/subscribe", { headers: { "api-key": apiKey }, data: { topic: "news", token } });
    }

    const estimate = async (data: Record<string, unknown>) => {
      const res = await request.post(`/api/admin/projects/${pid}/audience/estimate`, { headers: admin, data });
      expect(res.status()).toBe(200);
      return (await res.json()).data as { users: number; devices: number; platforms: Record<string, number> };
    };
    const sendAndLog = async (data: Record<string, unknown>) => {
      const send = await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { title: "t", body: "b", ...data } });
      expect(send.status()).toBe(202);
      const id = (await send.json()).data.message.id as string;
      await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });
      return (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;
    };

    const cases: Array<[Record<string, unknown>, { users: number; devices: number; platforms: Record<string, number> }]> = [
      [{ type: "single", target: "e-a" }, { users: 1, devices: 2, platforms: { ios: 1, android: 1, web: 0, other: 0 } }],
      [{ type: "multi", targets: ["e-a", "e-b", "nobody"] }, { users: 2, devices: 3, platforms: { ios: 1, android: 1, web: 1, other: 0 } }],
      [{ type: "topic", target: "news" }, { users: 1, devices: 2, platforms: { ios: 1, android: 1, web: 0, other: 0 } }],
      [{ type: "broadcast" }, { users: 2, devices: 4, platforms: { ios: 1, android: 2, web: 1, other: 0 } }],
    ];
    for (const [target, expected] of cases) {
      const est = await estimate(target);
      expect(est).toEqual(expected);
      const log = await sendAndLog(target);
      expect(log.totalCount).toBe(est.devices);
      expect(log.audienceUserCount).toBe(est.users);
      expect(log.audienceDeviceCount).toBe(est.devices);
    }

    // 없는 토픽·사용자는 0, 대상 필드 누락은 422
    expect((await estimate({ type: "topic", target: "no-such-topic" })).devices).toBe(0);
    expect((await estimate({ type: "single", target: "nobody" })).users).toBe(0);
    const bad = await request.post(`/api/admin/projects/${pid}/audience/estimate`, { headers: admin, data: { type: "multi" } });
    expect(bad.status()).toBe(422);
  });

  test("테스트 발송: 콘솔 라우트만 isTest 를 남기고 v1 은 무시한다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `testsend-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const admin = { "x-admin-token": ADMIN };
    const detail = async (id: string) =>
      (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;

    const viaAdmin = await request.post(`/api/admin/projects/${pid}/messages`, {
      headers: admin,
      data: { title: "t", body: "b", type: "single", target: "tester", test: true },
    });
    expect(viaAdmin.status()).toBe(202);
    const adminId = (await viaAdmin.json()).data.message.id as string;
    expect((await detail(adminId)).isTest).toBe(true);

    const viaV1 = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "single", target: "tester", test: true },
    });
    expect(viaV1.status()).toBe(202);
    const v1Id = (await viaV1.json()).data.message.id as string;
    expect((await detail(v1Id)).isTest).toBe(false);

    const list = (await (await request.get(`/api/admin/projects/${pid}/logs`, { headers: admin })).json()).data.logs as Array<{ id: string; isTest: boolean }>;
    expect(list.find((l) => l.id === adminId)?.isTest).toBe(true);
    expect(list.find((l) => l.id === v1Id)?.isTest).toBe(false);
  });

  test("이미지: http 는 422, https 는 로그 상세에 남는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `img-${Date.now()}` } });
    const cj = await created.json();
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const pid = cj.data.project.id as string;
    const admin = { "x-admin-token": ADMIN };

    const http = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "broadcast", image_url: "http://cdn.example.com/a.png" },
    });
    expect(http.status()).toBe(422);
    const httpAdmin = await request.post(`/api/admin/projects/${pid}/messages`, {
      headers: admin,
      data: { title: "t", body: "b", type: "broadcast", image_url: "http://cdn.example.com/a.png" },
    });
    expect(httpAdmin.status()).toBe(422);

    const url = "https://cdn.example.com/a.png";
    const ok = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { title: "t", body: "b", type: "broadcast", image_url: url },
    });
    expect(ok.status()).toBe(202);
    const id = (await ok.json()).data.message.id as string;
    const log = (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;
    expect(log.imageUrl).toBe(url);
    expect(log.isTest).toBe(false);
  });

  test("멱등 키: 같은 Idempotency-Key 재요청은 처음 발송을 200 으로 돌려준다(v1·admin)", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `idem-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const sdk = { "api-key": cj.data.project.apiKey as string, "api-secret": cj.data.api_secret as string };
    const admin = { "x-admin-token": ADMIN };
    const key = `order-${Date.now()}`;

    const first = await request.post("/api/v1/messages", { headers: { ...sdk, "Idempotency-Key": key }, data: { type: "broadcast", title: "t", body: "b" } });
    expect(first.status()).toBe(202);
    const fj = await first.json();
    // v1 응답은 DTO 만 — 내부 값(lock_token 등)이 나가지 않는다
    expect(Object.keys(fj.data.message).sort()).toEqual(["id", "scheduled_at", "status"]);

    const again = await request.post("/api/v1/messages", { headers: { ...sdk, "Idempotency-Key": key }, data: { type: "broadcast", title: "다른 본문", body: "b" } });
    expect(again.status()).toBe(200);
    const aj = await again.json();
    expect(aj.data.message.id).toBe(fj.data.message.id);
    expect(aj.meta.idempotent_replay).toBe(true);

    const bad = await request.post("/api/v1/messages", { headers: { ...sdk, "Idempotency-Key": "has space" }, data: { type: "broadcast", title: "t", body: "b" } });
    expect(bad.status()).toBe(400);

    const a1 = await request.post(`/api/admin/projects/${pid}/messages`, { headers: { ...admin, "Idempotency-Key": key }, data: { type: "broadcast", title: "t", body: "b" } });
    // 같은 프로젝트에서 키는 발송 경로와 무관하게 하나 — v1 에서 쓴 키는 콘솔에서도 재생으로 본다
    expect(a1.status()).toBe(200);
    expect((await a1.json()).data.message.id).toBe(fj.data.message.id);

    const logs = (await (await request.get(`/api/admin/projects/${pid}/logs`, { headers: admin })).json()).data.logs as unknown[];
    expect(logs.length).toBe(1);
  });

  test("발송자: v1 은 api, admin 토큰은 admin-token 으로 로그 상세 sentBy 에 남는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `sentby-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const sdk = { "api-key": cj.data.project.apiKey as string, "api-secret": cj.data.api_secret as string };
    const admin = { "x-admin-token": ADMIN };

    const v1 = (await (await request.post("/api/v1/messages", { headers: sdk, data: { type: "broadcast", title: "t", body: "b" } })).json()).data.message.id;
    const ad = (await (await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { type: "broadcast", title: "t", body: "b" } })).json()).data.message.id;
    const detail = async (id: string) => (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;
    expect((await detail(v1)).sentBy).toBe("api");
    expect((await detail(ad)).sentBy).toBe("admin-token");
  });

  test("FCM 페이로드: 직렬화 크기가 4KB 를 넘으면 422", async ({ request }) => {
    const { apiKey, apiSecret } = await createProject(request);
    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": apiKey, "api-secret": apiSecret },
      data: { type: "broadcast", title: "t", body: "x".repeat(3900), data: { note: "y".repeat(600) } },
    });
    expect(res.status()).toBe(422);
    expect((await res.json()).error).toMatch(/payload too large for FCM/);
  });

  test("빈도 상한: 24시간 상한에 걸린 사용자는 건너뛰고 테스트 발송은 예외", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `cap-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const apiSecret = cj.data.api_secret as string;
    const admin = { "x-admin-token": ADMIN };
    const reg = await request.post("/api/v1/devices", {
      headers: { "api-key": apiKey },
      data: { token: `cap-tok-${Date.now()}`, platform: "android", external_id: "capped", identity_hash: idHash("capped", apiSecret) },
    });
    expect(reg.status()).toBe(201);

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    await sql`update projects set frequency_cap_per_day = 1 where id = ${pid}`;

    const sendAndProcess = async (test = false) => {
      const res = await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { type: "single", target: "capped", title: "t", body: "b", test } });
      const id = (await res.json()).data.message.id as string;
      await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });
      return (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;
    };
    try {
      // Firebase 없는 로그 전용 발송은 수신 기록을 남기지 않는다 — 실제로 받은 것이 아니므로
      const first = await sendAndProcess();
      expect(first.totalCount).toBe(1);
      expect((await sendAndProcess()).totalCount).toBe(1);

      // 24시간 안에 실제로 한 번 받은 사용자로 만든다
      const [user] = await sql`select id from push_users where project_id = ${pid} and external_id = 'capped'`;
      await sql`insert into push_user_sends (project_id, user_id, log_id) values (${pid}, ${user.id}, ${first.id})`;
      expect((await sendAndProcess()).totalCount).toBe(0); // 상한 1 — 건너뛴다
      expect((await sendAndProcess(true)).totalCount).toBe(1); // 테스트 발송은 상한을 보지 않는다
    } finally {
      await sql.end();
    }
  });

  test("재클레임: 저장된 커서 뒤의 기기부터 이어 보내고 누적 수를 잇는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN }, data: { name: `resume-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const admin = { "x-admin-token": ADMIN };
    for (let i = 0; i < 3; i++) {
      const r = await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token: `resume-${Date.now()}-${i}`, platform: "android" } });
      expect(r.status()).toBe(201);
    }

    const res = await request.post(`/api/admin/projects/${pid}/messages`, { headers: admin, data: { type: "broadcast", title: "t", body: "b" } });
    const id = (await res.json()).data.message.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const ids = (await sql`select id from devices where project_id = ${pid} and is_active order by id`).map((r) => r.id as string);
      // 첫 기기까지 보낸 뒤 워커가 죽은 상태 — 앞서 7건을 보냈다고 기록돼 있다
      const state = { cursor: ids[0], total: 7, success: 0, failure: 0, variantStats: null, audience: { users: 0, devices: 3 } };
      await sql`update push_logs set status = 'processing', locked_at = now() - interval '10 minutes', resume_cursor = ${JSON.stringify(state)} where id = ${id}`;
    } finally {
      await sql.end();
    }

    await request.post(`/api/admin/projects/${pid}/process-queue`, { headers: admin, data: {} });
    const log = (await (await request.get(`/api/admin/projects/${pid}/logs/${id}`, { headers: admin })).json()).data.log;
    expect(log.status).toBe("logged");
    expect(log.totalCount).toBe(7 + 2); // 남은 두 기기만 더해진다
    expect(log.audienceDeviceCount).toBe(3);
  });
});
