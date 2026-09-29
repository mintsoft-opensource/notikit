import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import postgres from "postgres";
import { E2E_DATABASE_URL } from "./env";

const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
const admin = { "x-admin-token": ADMIN_TOKEN };
const SESSION_ADMIN = { email: "e2e-admin@notikit.dev", password: "e2e-password-1234" };
const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? "3100"}`;

function idHash(externalId: string, apiSecret: string): string {
  return createHmac("sha256", apiSecret).update(externalId).digest("hex");
}

async function createProject(request: APIRequestContext, prefix: string) {
  const res = await request.post("/api/admin/projects", { headers: admin, data: { name: `${prefix}-${Date.now()}` } });
  expect(res.status()).toBe(201);
  const j = (await res.json()).data;
  return { pid: j.project.id as string, apiKey: j.project.apiKey as string, apiSecret: j.api_secret as string };
}

async function identifyWithDevice(
  request: APIRequestContext,
  p: { apiKey: string; apiSecret: string },
  ext: string,
  attributes: Record<string, unknown>
) {
  const h = idHash(ext, p.apiSecret);
  const dev = await request.post("/api/v1/devices", {
    headers: { "api-key": p.apiKey },
    data: { token: `feat-${ext}-${Date.now()}`, platform: "web", external_id: ext, identity_hash: h },
  });
  expect(dev.ok()).toBeTruthy();
  const idf = await request.post("/api/v1/users/identify", {
    headers: { "api-key": p.apiKey },
    data: { external_id: ext, identity_hash: h, attributes },
  });
  expect(idf.ok()).toBeTruthy();
}

async function topicUserCount(request: APIRequestContext, pid: string, name: string, rules: unknown): Promise<number> {
  const mk = await request.post(`/api/admin/projects/${pid}/audience/topics`, { headers: admin, data: { name, rules } });
  expect(mk.status()).toBe(201);
  const tid = (await mk.json()).data.topic.id as string;
  const d = await request.get(`/api/admin/projects/${pid}/audience/topics/${tid}`, { headers: admin });
  return (await d.json()).data.userCount as number;
}

let cachedSession: string | null = null;
async function ensureLogin(page: Page) {
  if (cachedSession) {
    await page.context().addCookies([{ name: "notikit_session", value: cachedSession, url: ORIGIN }]);
    // 캐시한 쿠키가 아직 사는지 확인한다. 다른 스펙의 로그아웃이 세션을 무효화하면 이 쿠키는
    // 조용히 401 이 되고, 뒤따르는 테스트는 "프로젝트를 못 만든다" 처럼 엉뚱한 곳에서 깨진다.
    const alive = await page.request.get("/api/admin/projects");
    if (alive.ok()) return;
    cachedSession = null;
    await page.context().clearCookies();
  }
  const headers = { origin: ORIGIN };
  const reg = await page.request.post("/api/admin/register", {
    data: { org_name: "E2E", ...SESSION_ADMIN },
    headers: { ...headers, "x-bootstrap-token": process.env.BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token" },
  });
  if (!reg.ok()) {
    const login = await page.request.post("/api/admin/login", { data: SESSION_ADMIN, headers });
    expect(login.ok()).toBeTruthy();
  }
  cachedSession = (await page.context().cookies()).find((c) => c.name === "notikit_session")?.value ?? null;
  expect(cachedSession).toBeTruthy();
}

async function sessionProjectId(page: Page): Promise<string> {
  const list = await page.request.get("/api/admin/projects");
  const existing = (await list.json()).data?.projects?.[0]?.id;
  if (existing) return existing;
  const created = await page.request.post("/api/admin/projects", { data: { name: "e2e-features" }, headers: { origin: ORIGIN } });
  expect(created.ok()).toBeTruthy();
  return (await created.json()).data.project.id;
}

test.describe("W4 기능 보강", () => {
  test("같은 이름의 규칙식 토픽: 조건이 다르면 409, 같은 요청의 재시도면 200", async ({ request }) => {
    const p = await createProject(request, "dup-topic");
    const mk = (value: string) =>
      request.post(`/api/admin/projects/${p.pid}/audience/topics`, {
        headers: admin,
        data: { name: "vip", rules: [{ attribute: "plan", op: "eq", value }] },
      });
    expect((await mk("pro")).status()).toBe(201);
    // 새 조건이 조용히 버려지는데 성공처럼 보이면 안 된다
    expect((await mk("free")).status()).toBe(409);
    // jsonb 가 키 순서를 바꿔도 같은 규칙은 같은 요청이다
    expect((await mk("pro")).status()).toBe(200);
  });

  test("토픽 규칙 연산자: 숫자 비교·다름·포함, 숫자 아닌 속성은 오류 없이 제외", async ({ request }) => {
    const p = await createProject(request, "ops");
    await identifyWithDevice(request, p, "teen", { age: "15", plan: "free", email: "a@corp.example" });
    await identifyWithDevice(request, p, "adult", { age: "20", plan: "pro", email: "b@gmail.example" });
    await identifyWithDevice(request, p, "weird", { age: "unknown", plan: "pro" });

    expect(await topicUserCount(request, p.pid, "adults", [{ attribute: "age", op: "gte", value: "18" }])).toBe(1);
    expect(await topicUserCount(request, p.pid, "under-20", [{ attribute: "age", op: "lt", value: "20" }])).toBe(1);
    expect(await topicUserCount(request, p.pid, "not-free", [{ attribute: "plan", op: "neq", value: "free" }])).toBe(2);
    expect(await topicUserCount(request, p.pid, "corp", [{ attribute: "email", op: "contains", value: "CORP" }])).toBe(1);
    // op 없는 기존 규칙은 같음으로 동작한다
    expect(await topicUserCount(request, p.pid, "pro-legacy", [{ attribute: "plan", value: "pro" }])).toBe(2);

    const bad = await request.post(`/api/admin/projects/${p.pid}/audience/topics`, {
      headers: admin,
      data: { name: "bad-num", rules: [{ attribute: "age", op: "gt", value: "ten" }] },
    });
    expect(bad.status()).toBe(422);
    const badOp = await request.post(`/api/admin/projects/${p.pid}/audience/topics`, {
      headers: admin,
      data: { name: "bad-op", rules: [{ attribute: "age", op: "like", value: "1" }] },
    });
    expect(badOp.status()).toBe(422);
  });

  test("빈도 상한: 설정 조회·저장, 범위 밖은 422", async ({ request }) => {
    const p = await createProject(request, "cap");
    const url = `/api/admin/projects/${p.pid}`;
    const set = await request.patch(url, { headers: admin, data: { frequency_cap_per_day: 3 } });
    expect(set.status()).toBe(200);
    expect((await set.json()).data.project.frequencyCapPerDay).toBe(3);
    expect((await (await request.get(url, { headers: admin })).json()).data.project.frequencyCapPerDay).toBe(3);

    expect((await request.patch(url, { headers: admin, data: { frequency_cap_per_day: 101 } })).status()).toBe(422);
    expect((await request.patch(url, { headers: admin, data: { frequency_cap_per_day: 1.5 } })).status()).toBe(422);

    const clear = await request.patch(url, { headers: admin, data: { frequency_cap_per_day: null } });
    expect((await clear.json()).data.project.frequencyCapPerDay).toBeNull();
  });

  test("억제 CSV 가져오기: 중복·형식 오류·기존 대상은 건너뛴다", async ({ request }) => {
    const p = await createProject(request, "supp");
    const url = `/api/admin/projects/${p.pid}/audience/suppressions/import`;
    const csv = "user_id,reason\nu1,opt_out\nu2\nu1,manual\n,manual\nu3,not-a-reason\n";
    const first = await request.post(url, { headers: { ...admin, "content-type": "text/csv" }, data: csv });
    expect(first.status()).toBe(200);
    // batch_id 는 이번 라운드에 생긴 값 — 되돌리기(import/revert)가 가리킬 배치다.
    // "더 늘지 않았다" 를 지키려고 added/skipped 는 그대로 정확히 맞추고, batch_id 는 존재만 본다.
    const firstBody = (await first.json()).data as { added: number; skipped: number; batch_id: string };
    expect({ added: firstBody.added, skipped: firstBody.skipped }).toEqual({ added: 2, skipped: 3 });
    expect(firstBody.batch_id).toEqual(expect.any(String));

    const again = await request.post(url, { headers: admin, data: { rows: [{ user_id: "u1" }, { token: "tok-x" }] } });
    const againBody = (await again.json()).data as { added: number; skipped: number; batch_id: string };
    expect({ added: againBody.added, skipped: againBody.skipped }).toEqual({ added: 1, skipped: 1 });
    // 가져오기마다 배치가 새로 생긴다 — 되돌리기는 이 배치 하나만 건드려야 한다
    expect(againBody.batch_id).not.toBe(firstBody.batch_id);

    const list = await request.get(`/api/admin/projects/${p.pid}/audience/suppressions`, { headers: admin });
    const rows = (await list.json()).data.suppressions as Array<{ externalId: string | null; reason: string }>;
    expect(rows.find((r) => r.externalId === "u1")?.reason).toBe("opt_out");
    expect(rows).toHaveLength(3);

    const noHeader = await request.post(url, { headers: { ...admin, "content-type": "text/csv" }, data: "name\nx" });
    expect(noHeader.status()).toBe(422);
    const tooMany = ["user_id", ...Array.from({ length: 5001 }, (_, i) => `bulk-${i}`)].join("\n");
    expect((await request.post(url, { headers: { ...admin, "content-type": "text/csv" }, data: tooMany })).status()).toBe(422);
  });

  test("웹훅 배달 이력: 최신순·상태 필터·다른 프로젝트 웹훅은 404", async ({ request }) => {
    const p = await createProject(request, "whd");
    const other = await createProject(request, "whd-other");
    const mk = await request.post(`/api/admin/projects/${p.pid}/webhooks`, {
      headers: admin,
      data: { url: "https://example.com/hook", events: [] },
    });
    expect(mk.ok()).toBeTruthy();
    const hooks = await request.get(`/api/admin/projects/${p.pid}/webhooks`, { headers: admin });
    const wid = (await hooks.json()).data.webhooks[0].id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      await sql`insert into webhook_deliveries (webhook_id, event, payload, status, attempts, last_status_code, created_at)
        values (${wid}, 'message.sent', '{}'::jsonb, 'delivered', 1, 200, now() - interval '2 minutes'),
               (${wid}, 'message.failed', '{}'::jsonb, 'failed', 3, 500, now() - interval '1 minute')`;
    } finally {
      await sql.end();
    }

    const base = `/api/admin/projects/${p.pid}/webhooks/${wid}/deliveries`;
    const all = (await (await request.get(base, { headers: admin })).json()).data;
    expect(all.deliveries.map((d: { status: string }) => d.status)).toEqual(["failed", "delivered"]);
    expect(all.deliveries[0]).toMatchObject({ event: "message.failed", attempts: 3, lastStatusCode: 500 });
    expect(all.deliveries[0].payload).toBeUndefined();

    const failed = (await (await request.get(`${base}?status=failed`, { headers: admin })).json()).data;
    expect(failed.deliveries).toHaveLength(1);
    expect((await request.get(`${base}?status=nope`, { headers: admin })).status()).toBe(422);
    expect((await request.get(`/api/admin/projects/${other.pid}/webhooks/${wid}/deliveries`, { headers: admin })).status()).toBe(404);
  });

  test("로그 상세: A/B 변형과 발송자(sentBy)가 내려온다", async ({ request }) => {
    const p = await createProject(request, "ab");
    await identifyWithDevice(request, p, "ab-user", { plan: "pro" });
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: {
        title: "A 제목",
        body: "A 본문",
        type: "broadcast",
        variants: [{ title: "A 제목", body: "A 본문" }, { title: "B 제목", body: "B 본문" }],
      },
    });
    expect(send.status()).toBe(202);
    const id = (await send.json()).data.message.id as string;
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });

    const d = (await (await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin })).json()).data.log;
    expect(d.variants).toHaveLength(2);
    expect(d.sentBy).toBe("api");
  });

  test("발송 화면: 변형 B 추가 → 변형 제목·본문 입력칸, 미리보기 변형 탭", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/send/broadcast`);
    await page.getByRole("button", { name: "변형 B 추가" }).click();
    await expect(page.getByLabel("변형 B 제목")).toBeVisible();
    await expect(page.getByLabel("변형 B 본문")).toBeVisible();
    await expect(page.getByRole("tab", { name: "변형 B" })).toBeVisible();

    // 변형을 비워 두면 검토 창을 열지 않는다
    await page.getByLabel("제목", { exact: true }).fill("기본 제목");
    await page.getByLabel("본문", { exact: true }).fill("기본 본문");
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await expect(page.getByText("추가한 변형의 제목과 본문을 모두 입력하거나 변형을 삭제하세요")).toBeVisible();

    await page.getByRole("button", { name: "변형 B 삭제" }).click();
    await expect(page.getByLabel("변형 B 제목")).toHaveCount(0);
  });

  test("설정 화면: 하루 최대 수신 횟수 입력칸", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/settings`);
    await expect(page.getByLabel("하루 최대 수신 횟수")).toBeVisible();
  });
});

test.describe("A 알림 옵션 · 전환 측정", () => {
  async function sendAndProcess(request: APIRequestContext, p: { pid: string; apiKey: string; apiSecret: string }, data: unknown) {
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: data as Record<string, unknown>,
    });
    expect(send.status()).toBe(202);
    const id = (await send.json()).data.message.id as string;
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    return id;
  }

  test("알림 옵션: 저장되고, 범위를 벗어난 값은 422", async ({ request }) => {
    const p = await createProject(request, "opts");
    const options = {
      sound: "default",
      badge: 3,
      collapse_key: "cart",
      android_channel_id: "promo",
      ios_thread_id: "orders",
      ttl_seconds: 3600,
      priority: "normal",
      actions: [{ id: "buy", title: "결제하기", deep_link: "https://shop.test/cart" }],
    };
    const id = await sendAndProcess(request, p, { title: "제목", body: "본문", type: "broadcast", options });

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select options from push_logs where id = ${id}`;
      expect(rows[0].options).toEqual(options);
    } finally {
      await sql.end();
    }

    const headers = { "api-key": p.apiKey, "api-secret": p.apiSecret };
    const bad = [
      { ttl_seconds: 2419201 },
      { ttl_seconds: -1 },
      { badge: -1 },
      { priority: "urgent" },
      { actions: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }, { id: "d", title: "D" }] },
      { actions: [{ id: "a", title: "A" }, { id: "a", title: "또 A" }] },
    ];
    for (const options of bad) {
      const res = await request.post("/api/v1/messages", { headers, data: { title: "t", body: "b", type: "broadcast", options } });
      expect(res.status()).toBe(422);
    }
  });

  test("무음 푸시: 제목·본문 없이도 발송된다", async ({ request }) => {
    const p = await createProject(request, "silent");
    const id = await sendAndProcess(request, p, { type: "broadcast", data: { sync: "1" }, options: { silent: true } });

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select title, body, options from push_logs where id = ${id}`;
      expect(rows[0].title).toBe("");
      expect(rows[0].body).toBe("");
      expect(rows[0].options).toMatchObject({ silent: true });
    } finally {
      await sql.end();
    }

    // 무음이 아니면 제목·본문은 여전히 필수다
    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: { type: "broadcast", data: { sync: "1" } },
    });
    expect(res.status()).toBe(422);
  });

  test("변형별 클릭: 클릭에 그 기기의 변형이 기록된다", async ({ request }) => {
    const p = await createProject(request, "vclick");
    const ext = "variant-click-user";
    const token = `vc-tok-${Date.now()}`;
    await request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android", user_id: ext, identity_hash: idHash(ext, p.apiSecret) },
    });
    const id = await sendAndProcess(request, p, {
      title: "A 제목",
      body: "A 본문",
      type: "single",
      target: ext,
      variants: [{ title: "A 제목", body: "A 본문" }, { title: "B 제목", body: "B 본문" }],
    });

    const click = await request.post("/api/v1/messages/click", { headers: { "api-key": p.apiKey }, data: { log_id: id, token } });
    expect(click.status()).toBe(202);

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select variant from push_clicks where log_id = ${id}`;
      expect(rows).toHaveLength(1);
      // 배정은 토큰 해시라 값이 정해져 있지는 않지만 변형 범위 안이어야 한다
      expect([0, 1]).toContain(rows[0].variant);
    } finally {
      await sql.end();
    }
  });

  test("전환: 클릭이 있어야 귀속되고, 같은 날 같은 이름은 1건", async ({ request }) => {
    const p = await createProject(request, "conv");
    const ext = "conv-user";
    const token = `cv-tok-${Date.now()}`;
    const h = idHash(ext, p.apiSecret);
    await request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android", user_id: ext, identity_hash: h },
    });
    const id = await sendAndProcess(request, p, { title: "제목", body: "본문", type: "single", target: ext });

    // 클릭 전에는 귀속할 발송이 없다 — 오류가 아니라 저장하지 않는다
    const before = await request.post("/api/v1/events", { headers: { "api-key": p.apiKey }, data: { name: "purchase", token } });
    expect(before.status()).toBe(202);
    expect((await before.json()).data).toMatchObject({ recorded: false, attributed: false });

    await request.post("/api/v1/messages/click", { headers: { "api-key": p.apiKey }, data: { log_id: id, token } });

    const first = await request.post("/api/v1/events", {
      headers: { "api-key": p.apiKey },
      data: { name: "purchase", value_cents: 19900, token },
    });
    expect(first.status()).toBe(202);
    expect((await first.json()).data).toMatchObject({ recorded: true, attributed: true, message_id: id });

    // 같은 (발송, 사람, 이름)은 하루 1건 — 재시도해도 매출이 부풀지 않는다
    const again = await request.post("/api/v1/events", {
      headers: { "api-key": p.apiKey },
      data: { name: "purchase", value_cents: 19900, token },
    });
    expect((await again.json()).data).toMatchObject({ recorded: false, attributed: true });

    // 이름이 다르면 별개의 전환
    const signup = await request.post("/api/v1/events", { headers: { "api-key": p.apiKey }, data: { name: "signup", user_id: ext, identity_hash: h } });
    expect((await signup.json()).data).toMatchObject({ recorded: true, attributed: true });

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select name, value_cents from push_conversions where log_id = ${id} order by name`;
      expect(rows.map((r) => r.name)).toEqual(["purchase", "signup"]);
      expect(rows[0].value_cents).toBe(19900);
      expect(rows[1].value_cents).toBeNull();
    } finally {
      await sql.end();
    }
  });

  test("전환 검증: 대상은 token 과 user_id 중 하나, user_id 는 identity_hash 필수", async ({ request }) => {
    const p = await createProject(request, "convguard");
    const key = { "api-key": p.apiKey };
    const post = (data: unknown) => request.post("/api/v1/events", { headers: key, data: data as Record<string, unknown> });

    expect((await post({ name: "purchase" })).status()).toBe(422);
    expect((await post({ name: "purchase", token: "t", user_id: "u" })).status()).toBe(422);
    expect((await post({ name: "  ", token: "t" })).status()).toBe(422);
    expect((await post({ name: "purchase", token: "t", value_cents: -1 })).status()).toBe(422);
    expect((await post({ name: "purchase", user_id: "nobody" })).status()).toBe(403);
    expect((await post({ name: "purchase", user_id: "nobody", identity_hash: "wrong" })).status()).toBe(403);
    expect((await post({ name: "purchase", user_id: "nobody", identity_hash: idHash("nobody", p.apiSecret) })).status()).toBe(404);
    expect((await post({ name: "purchase", token: "never-registered" })).status()).toBe(404);
    expect((await request.post("/api/v1/events", { data: { name: "purchase", token: "t" } })).status()).toBe(401);
  });
});

test.describe("A 알림 옵션 · 전환 콘솔 UI", () => {
  test("발송 화면: 알림 옵션을 펼쳐 값을 넣으면 options 로 실려 나간다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/send/broadcast`);

    // 접혀 있다 — 대부분의 발송은 기본값으로 나가므로 칸을 먼저 보여 주지 않는다
    const toggle = page.getByRole("button", { name: "알림 옵션" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");

    await page.getByLabel("제목", { exact: true }).fill("옵션 제목");
    await page.getByLabel("본문", { exact: true }).fill("옵션 본문");
    await page.getByLabel("소리").fill("default");
    await page.getByLabel("배지 숫자").fill("3");
    await page.getByLabel("묶음 키").fill("cart");
    await page.getByLabel("유효기간 (초)").fill("3600");
    await page.getByLabel("우선순위").selectOption("normal");

    await page.getByRole("button", { name: "액션 버튼 추가" }).click();
    await page.getByLabel("아이디").fill("buy");
    await page.getByLabel("버튼 이름").fill("결제하기");
    await page.getByLabel("액션 딥링크 (선택)").fill("https://shop.test/cart");

    // 실제로 큐에 넣지 않는다 — 공용 프로젝트에 전체 발송이 쌓이면 다른 테스트의 집계가 흔들린다
    let posted: Record<string, unknown> = {};
    await page.route(`**/api/admin/projects/${pid}/messages`, async (route) => {
      posted = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ data: { message: { id: "stub" } } }) });
    });

    await page.getByRole("button", { name: "검토 후 발송" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /발송/ }).click();
    await expect.poll(() => Object.keys(posted).length).toBeGreaterThan(0);
    const body = posted;
    expect(body.options).toMatchObject({
      sound: "default",
      badge: 3,
      collapse_key: "cart",
      ttl_seconds: 3600,
      priority: "normal",
      actions: [{ id: "buy", title: "결제하기", deep_link: "https://shop.test/cart" }],
    });
  });

  test("발송 화면: 범위를 벗어난 옵션은 보이는 오류로 막는다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/send/broadcast`);
    await page.getByRole("button", { name: "알림 옵션" }).click();
    await page.getByLabel("배지 숫자").fill("100000");
    await expect(page.getByText("배지 숫자는 0 이상 99999 이하의 정수여야 합니다")).toBeVisible();

    // 접어 둔 채로 발송해도 옵션 칸이 다시 펼쳐져 어디가 틀렸는지 보인다
    await page.getByRole("button", { name: "알림 옵션" }).click();
    await page.getByLabel("제목", { exact: true }).fill("제목");
    await page.getByLabel("본문", { exact: true }).fill("본문");
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await expect(page.getByText("알림 옵션에 잘못된 값이 있습니다")).toBeVisible();
    await expect(page.getByRole("button", { name: "알림 옵션" })).toHaveAttribute("aria-expanded", "true");
  });

  test("발송 화면: 무음 푸시는 제목·본문 없이 검토 창까지 간다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/send/broadcast`);
    await page.getByRole("button", { name: "알림 옵션" }).click();
    await page.getByLabel("무음 푸시 (data-only)").check();

    // 왜 미리보기가 비는지 화면이 설명한다
    await expect(page.getByText("알림이 표시되지 않아 미리 볼 화면이 없습니다", { exact: false })).toBeVisible();

    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await expect(page.getByText("무음 푸시로 나갑니다", { exact: false })).toBeVisible();
  });

  test("로그 상세: 변형별 클릭 수·클릭률과 전환 카드", async ({ page, request }) => {
    await ensureLogin(page);
    // 세션(브라우저)으로 만든다 — admin 토큰으로 만들면 다른 org 소속이라 콘솔에서 404 가 난다
    const created = await page.request.post("/api/admin/projects", {
      data: { name: `uiclick-${Date.now()}` },
      headers: { origin: ORIGIN },
    });
    expect(created.status()).toBe(201);
    const j = (await created.json()).data;
    const p = { pid: j.project.id as string, apiKey: j.project.apiKey as string, apiSecret: j.api_secret as string };
    const ext = "ui-click-user";
    const token = `uic-tok-${Date.now()}`;
    await request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android", user_id: ext, identity_hash: idHash(ext, p.apiSecret) },
    });
    const send = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: {
        title: "A 제목",
        body: "A 본문",
        type: "single",
        target: ext,
        variants: [{ title: "A 제목", body: "A 본문" }, { title: "B 제목", body: "B 본문" }],
      },
    });
    expect(send.status()).toBe(202);
    const id = (await send.json()).data.message.id as string;
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    await request.post("/api/v1/messages/click", { headers: { "api-key": p.apiKey }, data: { log_id: id, token } });
    await request.post("/api/v1/events", {
      headers: { "api-key": p.apiKey },
      data: { name: "purchase", value_cents: 19900, token },
    });

    const detail = (await (await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin })).json()).data;
    expect(detail.clicks.byVariant).toHaveLength(1);
    expect(detail.conversions).toMatchObject({ count: 1, valueCents: 19900 });
    expect(detail.conversions.byName[0]).toMatchObject({ name: "purchase", count: 1, valueCents: 19900 });

    await page.goto(`/projects/${p.pid}/logs/${id}`);
    await expect(page.getByRole("columnheader", { name: "클릭", exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "클릭률" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "전환" })).toBeVisible();
    await expect(page.getByText("아직 전환이 없습니다")).toHaveCount(0);
  });

  test("통계: 전환 KPI 가 stats 응답과 개요 화면에 있다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    const stats = (await (await page.request.get(`/api/admin/projects/${pid}/stats?range=7d`)).json()).data;
    expect(stats.conversions).toMatchObject({ count: expect.any(Number), value_cents: expect.any(Number) });
    expect(stats.previous.conversions).toEqual(expect.any(Number));
    expect(stats.previous.conversion_value_cents).toEqual(expect.any(Number));

    await page.goto(`/projects/${pid}`);
    await expect(page.getByText("전환", { exact: true }).first()).toBeVisible();
    await page.goto(`/projects/${pid}/engagement`);
    await expect(page.getByText("전환", { exact: true }).first()).toBeVisible();
  });
});

test.describe("P3 반복 예약", () => {
  test("반복 예약: 만들고 검증하고 끄고 지운다", async ({ request }) => {
    const p = await createProject(request, "sched");
    const base = `/api/admin/projects/${p.pid}/schedules`;

    const create = await request.post(base, {
      headers: admin,
      data: {
        name: "아침 리마인더",
        kind: "daily",
        hour: 9,
        minute: 0,
        message: { title: "좋은 아침", body: "오늘의 소식", type: "broadcast" },
      },
    });
    expect(create.status()).toBe(201);
    const s = (await create.json()).data.schedule;
    expect(s.enabled).toBe(true);
    // 만들자마자 다음 도래 시각이 잡힌다 — 비어 있으면 워커가 영영 집지 않는다
    expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    // 주기에 필요한 칸이 비면 거절한다
    const noWeekday = await request.post(base, {
      headers: admin,
      data: { name: "x", kind: "weekly", hour: 9, minute: 0, message: { title: "a", body: "b", type: "broadcast" } },
    });
    expect(noWeekday.status()).toBe(422);
    // 토픽 발송인데 대상이 없으면 거절한다 (발송 스키마와 같은 규칙)
    const noTarget = await request.post(base, {
      headers: admin,
      data: { name: "x", kind: "daily", hour: 9, minute: 0, message: { title: "a", body: "b", type: "topic" } },
    });
    expect(noTarget.status()).toBe(422);

    // 끄면 도래 시각이 비워지고, 처리기가 집지 않는다
    const off = await request.patch(`${base}/${s.id}`, { headers: admin, data: { enabled: false } });
    expect(off.ok()).toBeTruthy();
    expect((await off.json()).data.schedule.nextRunAt).toBeNull();
    const idle = await request.post(`${base}/process`, { headers: admin, data: {} });
    expect((await idle.json()).data).toMatchObject({ checked: 0, fired: 0, skipped: 0 });

    // 다시 켜면 지금 기준으로 다시 잡는다
    const on = await request.patch(`${base}/${s.id}`, { headers: admin, data: { enabled: true } });
    expect(new Date((await on.json()).data.schedule.nextRunAt).getTime()).toBeGreaterThan(Date.now());

    const del = await request.delete(`${base}/${s.id}`, { headers: admin });
    expect(del.ok()).toBeTruthy();
    const list = await request.get(base, { headers: admin });
    expect((await list.json()).data.schedules).toHaveLength(0);
  });

  test("반복 예약: 도래하면 로그 1행 — 두 번 처리해도 늘지 않는다", async ({ request }) => {
    const p = await createProject(request, "schedfire");
    const base = `/api/admin/projects/${p.pid}/schedules`;
    const create = await request.post(base, {
      headers: admin,
      data: {
        name: "도래 테스트",
        kind: "daily",
        hour: 9,
        minute: 0,
        message: { title: "예약 발송", body: "본문", type: "broadcast" },
      },
    });
    const id = (await create.json()).data.schedule.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      // 1분 전 회차가 도래한 상태로 만든다 (유예 15분 안)
      await sql`update push_schedules
                   set hour = extract(hour from (now() - interval '1 minute') at time zone 'UTC')::int,
                       minute = extract(minute from (now() - interval '1 minute') at time zone 'UTC')::int,
                       next_run_at = now() - interval '1 minute'
                 where id = ${id}`;

      const first = await request.post(`${base}/process`, { headers: admin, data: {} });
      expect((await first.json()).data).toMatchObject({ fired: 1, skipped: 0 });

      // 같은 회차를 다시 도래시켜도 멱등 키가 두 번째 로그를 막는다
      await sql`update push_schedules set next_run_at = now() - interval '1 minute', last_run_at = null where id = ${id}`;
      const second = await request.post(`${base}/process`, { headers: admin, data: {} });
      expect((await second.json()).data.fired).toBe(0);

      const logs = await sql`select id from push_logs where project_id = ${p.pid} and sent_by = 'schedule'`;
      expect(logs).toHaveLength(1);
    } finally {
      await sql.end();
    }
  });

  test("반복 예약: 다운타임 뒤 밀린 회차를 몰아 보내지 않는다", async ({ request }) => {
    const p = await createProject(request, "schedskip");
    const base = `/api/admin/projects/${p.pid}/schedules`;
    const create = await request.post(base, {
      headers: admin,
      data: {
        name: "밀린 예약",
        kind: "daily",
        hour: 9,
        minute: 0,
        message: { title: "밀린 발송", body: "본문", type: "broadcast" },
      },
    });
    const id = (await create.json()).data.schedule.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      // 사흘 전부터 멈춰 있었고, 오늘 회차도 유예를 넘겼다 → 한 건도 나가면 안 된다
      await sql`update push_schedules
                   set hour = extract(hour from (now() - interval '3 hours') at time zone 'UTC')::int,
                       minute = extract(minute from (now() - interval '3 hours') at time zone 'UTC')::int,
                       next_run_at = now() - interval '3 days'
                 where id = ${id}`;

      const res = await request.post(`${base}/process`, { headers: admin, data: {} });
      const data = (await res.json()).data;
      expect(data.fired).toBe(0);
      expect(data.skipped).toBeGreaterThan(0);

      const logs = await sql`select id from push_logs where project_id = ${p.pid} and sent_by = 'schedule'`;
      expect(logs).toHaveLength(0);

      // 도래 시각은 앞으로 전진한다 — 안 그러면 매 tick 마다 같은 판정을 반복한다
      const rows = await sql`select next_run_at from push_schedules where id = ${id}`;
      expect(new Date(rows[0].next_run_at as string).getTime()).toBeGreaterThan(Date.now());
    } finally {
      await sql.end();
    }
  });

  test("반복 예약 화면: 목록·다음 발송·켜고 끄기", async ({ page }) => {
    await ensureLogin(page);
    const created = await page.request.post("/api/admin/projects", {
      data: { name: `schedui-${Date.now()}` },
      headers: { origin: ORIGIN },
    });
    expect(created.status()).toBe(201);
    const pid = (await created.json()).data.project.id as string;

    await page.goto(`/projects/${pid}/schedules`);
    await expect(page.getByRole("heading", { name: "반복 예약" })).toBeVisible();
    await expect(page.getByText("아직 반복 예약이 없습니다.")).toBeVisible();

    await page.getByRole("button", { name: "새 예약" }).click();
    // 빈 폼으로 저장하면 칸마다 오류가 보인다
    await page.getByRole("button", { name: "예약 만들기" }).click();
    await expect(page.getByText("이름을 입력하세요.")).toBeVisible();
    await expect(page.getByText("제목을 입력하세요.")).toBeVisible();

    await page.getByLabel("이름").fill("주간 소식");
    await page.getByLabel("주기").selectOption("weekly");
    await expect(page.getByLabel("요일")).toBeVisible();
    await page.getByLabel("요일").selectOption("3");
    await page.getByLabel("시각").fill("10:30");
    await page.getByLabel("제목").fill("이번 주 소식");
    await page.getByLabel("본문").fill("새 소식이 도착했습니다");
    await page.getByRole("button", { name: "예약 만들기" }).click();

    await expect(page.getByText("주간 소식")).toBeVisible();
    await expect(page.getByText("매주 수요일 10:30")).toBeVisible();
    await expect(page.getByText(/다음 발송/)).toBeVisible();
    await expect(page.getByText("켜짐")).toBeVisible();

    await page.getByRole("button", { name: "주간 소식 — 끄기" }).click();
    await expect(page.getByText("꺼짐")).toBeVisible();
    await expect(page.getByText("예정 없음")).toBeVisible();
  });
});

/**
 * P1 행동 기반 세그먼트.
 *
 * 여기서 꼭 지켜보는 것: 행동 규칙 토픽이 **사람이 연결되지 않은 기기**를 세는가.
 * 규칙식 경로가 push_users 를 inner join 하던 시절엔 익명 기기가 통째로 빠져
 * "휴면 재활성" 같은 세그먼트가 조용히 반토막 났고, 줄어든 쪽은 오류를 내지 않았다.
 */
test.describe("P1 행동 기반 세그먼트", () => {
  async function topicCounts(request: APIRequestContext, pid: string, name: string, rules: unknown) {
    const mk = await request.post(`/api/admin/projects/${pid}/audience/topics`, { headers: admin, data: { name, rules } });
    expect(mk.status()).toBe(201);
    const tid = (await mk.json()).data.topic.id as string;
    const d = (await (await request.get(`/api/admin/projects/${pid}/audience/topics/${tid}`, { headers: admin })).json()).data;
    return { tid, devices: d.deviceCount as number, users: d.userCount as number };
  }

  test("행동 규칙 토픽이 사람 없는 기기도 센다 (속성 규칙은 그대로)", async ({ request }) => {
    const p = await createProject(request, "behavior-seg");

    // 사람이 붙은 기기 하나 + 익명 기기 하나
    await identifyWithDevice(request, p, "beh-known", { plan: "pro" });
    const anon = await request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token: `beh-anon-${Date.now()}`, platform: "android" },
    });
    expect(anon.ok()).toBeTruthy();

    // "최근 7일 안에 푸시를 클릭하지 않음" — 둘 다 클릭한 적이 없으니 둘 다 대상이다
    const dormant = await topicCounts(request, p.pid, "beh-dormant", [
      { source: "click", op: "not_within_days", days: 7 },
    ]);
    expect(dormant.devices).toBe(2);
    expect(dormant.users).toBe(1); // 익명 기기는 사람 분모에 잡히지 않는다

    // 속성 규칙의 뜻은 바뀌지 않는다 — 속성이 없는 익명 기기는 여전히 빠진다
    const pro = await topicCounts(request, p.pid, "beh-pro", [{ attribute: "plan", value: "pro" }]);
    expect(pro.devices).toBe(1);

    // 섞어 써도 AND 로 걸린다
    const both = await topicCounts(request, p.pid, "beh-both", [
      { attribute: "plan", value: "pro" },
      { source: "click", op: "not_within_days", days: 7 },
    ]);
    expect(both.devices).toBe(1);
  });

  test("반쪽짜리 행동 규칙은 422 로 막고 어느 칸이 틀렸는지 말한다", async ({ request }) => {
    const p = await createProject(request, "behavior-bad");
    const post = (rules: unknown) =>
      request.post(`/api/admin/projects/${p.pid}/audience/topics`, {
        headers: admin,
        data: { name: `bad-${Math.random().toString(36).slice(2)}`, rules },
      });

    // 기간 없는 "최근 N일 안에 없음"을 통과시키면 대상이 프로젝트 전체로 부푼다
    const noDays = await post([{ source: "activity", op: "not_within_days" }]);
    expect(noDays.status()).toBe(422);
    expect((await noDays.json()).error).toContain("days");

    const noCount = await post([{ source: "click", op: "count_gte" }]);
    expect(noCount.status()).toBe(422);
    expect((await noCount.json()).error).toContain("count");

    const unknownSource = await post([{ source: "login", op: "within_days", days: 7 }]);
    expect(unknownSource.status()).toBe(422);

    // 전환이 아닌 곳의 이름은 조건이 되지 않는다 — 조용히 무시하면 있지도 않은 조건을 있다고 읽는다
    const strayName = await post([{ source: "click", op: "within_days", days: 7, name: "purchase" }]);
    expect(strayName.status()).toBe(422);
  });

  test("토픽 상세: JSON 없이 화면에서 행동 조건을 만든다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    const mk = await page.request.post(`/api/admin/projects/${pid}/audience/topics`, {
      headers: { origin: ORIGIN },
      data: { name: `ui-behavior-${Date.now()}`, rules: [{ attribute: "plan", value: "pro" }] },
    });
    expect(mk.status()).toBe(201);
    const tid = (await mk.json()).data.topic.id as string;

    await page.goto(`/projects/${pid}/topics/${tid}`);
    const row = page.getByRole("group", { name: "조건 1" });
    await row.getByLabel("대상").selectOption("conversion");

    // 속성 칸이 행동 칸으로 바뀐다
    await expect(row.getByLabel("행동 조건")).toBeVisible();
    await expect(row.getByLabel("속성")).toHaveCount(0);
    await row.getByLabel("행동 조건").selectOption("count_gte");
    await row.getByLabel("전환 이름").fill("purchase");
    await row.getByLabel("횟수").fill("2");

    // 범위 밖 기간은 그 칸에 붙어서 보인다
    await row.getByLabel("기간(일)").fill("0");
    await expect(page.getByText("기간은 1~365 사이의 정수여야 합니다")).toBeVisible();
    await row.getByLabel("기간(일)").fill("30");
    await expect(page.getByText("기간은 1~365 사이의 정수여야 합니다")).toHaveCount(0);

    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.getByText("조건을 저장했습니다")).toBeVisible();

    // 저장된 규칙이 다시 읽혀 같은 칸으로 돌아온다
    await page.reload();
    const saved = page.getByRole("group", { name: "조건 1" });
    await expect(saved.getByLabel("대상")).toHaveValue("conversion");
    await expect(saved.getByLabel("횟수")).toHaveValue("2");
    await expect(saved.getByLabel("전환 이름")).toHaveValue("purchase");

    const detail = (await (await page.request.get(`/api/admin/projects/${pid}/audience/topics/${tid}`)).json()).data;
    expect(detail.topic.rules).toEqual([
      { source: "conversion", op: "count_gte", days: 30, count: 2, name: "purchase" },
    ]);
  });

  test("조건 행을 더하고 지워도 초점이 화면 안에 남는다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    const mk = await page.request.post(`/api/admin/projects/${pid}/audience/topics`, {
      headers: { origin: ORIGIN },
      data: { name: `ui-focus-${Date.now()}`, rules: [{ source: "activity", op: "not_within_days", days: 30 }] },
    });
    expect(mk.status()).toBe(201);
    const tid = (await mk.json()).data.topic.id as string;

    await page.goto(`/projects/${pid}/topics/${tid}`);
    await page.getByRole("button", { name: "조건 추가" }).click();
    // 새 행의 첫 입력칸으로 간다 — 추가 버튼에 초점이 남으면 어디에 쓰는지 알 수 없다
    await expect(page.getByRole("group", { name: "조건 2" }).getByLabel("속성")).toBeFocused();

    await page.getByRole("group", { name: "조건 2" }).getByRole("button", { name: "조건 삭제" }).click();
    await expect(page.getByRole("group", { name: "조건 2" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "조건 1" }).getByLabel("기간(일)")).toBeFocused();
  });
});

// ─── 발송 옵션: 현지 시각 · 속도 제한 ────────────────────────────────────────

test.describe("현지 시각 발송과 속도 제한", () => {
  test("분당 발송 상한을 저장하고 되읽는다 — 0 이나 음수는 거절", async ({ request }) => {
    const p = await createProject(request, "throttle");

    const set = await request.patch(`/api/admin/projects/${p.pid}`, {
      headers: { ...admin, origin: ORIGIN },
      data: { max_sends_per_minute: 500 },
    });
    expect(set.status()).toBe(200);
    expect((await set.json()).data.project.maxSendsPerMinute).toBe(500);

    const read = await request.get(`/api/admin/projects/${p.pid}`, { headers: admin });
    expect((await read.json()).data.project.maxSendsPerMinute).toBe(500);

    const bad = await request.patch(`/api/admin/projects/${p.pid}`, {
      headers: { ...admin, origin: ORIGIN },
      data: { max_sends_per_minute: 0 },
    });
    expect(bad.status()).toBe(422);

    // null 은 "제한 없음" — 껐다 켤 수 있어야 한다
    const off = await request.patch(`/api/admin/projects/${p.pid}`, {
      headers: { ...admin, origin: ORIGIN },
      data: { max_sends_per_minute: null },
    });
    expect((await off.json()).data.project.maxSendsPerMinute).toBeNull();
  });

  test("local_time 은 HH:MM 만 받고, 받은 값은 발송에 남는다", async ({ request }) => {
    const p = await createProject(request, "localtime");
    await identifyWithDevice(request, p, "lt-user", {});
    const headers = { "api-key": p.apiKey, "api-secret": p.apiSecret };

    const bad = await request.post("/api/v1/messages", {
      headers,
      data: { title: "t", body: "b", type: "broadcast", local_time: "9:00" },
    });
    expect(bad.status()).toBe(422);

    const ok = await request.post("/api/v1/messages", {
      headers,
      data: { title: "아침 소식", body: "확인해 보세요", type: "broadcast", local_time: "09:00" },
    });
    expect(ok.status()).toBe(202);
    const id = (await ok.json()).data.message.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select local_time from push_logs where id = ${id}`;
      expect(rows[0].local_time).toBe("09:00");
    } finally {
      await sql.end();
    }
  });
});

// ─── 트리거 저니: 이벤트 진입 · 분기 · 종료 조건 ─────────────────────────────

const BRANCH_JOURNEY = [
  { type: "entry", event: "signup" },
  { type: "send", title: "환영합니다", body: "시작해 보세요" },
  {
    type: "branch",
    withinHours: 1,
    yes: [{ type: "send", title: "고맙습니다", body: "계속 둘러보세요" }],
    no: [{ type: "send", title: "한 번 더", body: "아직 안 보셨네요" }],
  },
  { type: "exit", event: "purchase" },
];

async function createJourney(request: APIRequestContext, pid: string, name: string, steps: unknown[]) {
  const res = await request.post(`/api/admin/projects/${pid}/journeys`, {
    headers: { ...admin, origin: ORIGIN },
    data: { name, steps },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).data.journey.id as string;
}

async function drain(request: APIRequestContext, pid: string) {
  const res = await request.post(`/api/admin/projects/${pid}/journeys/process`, {
    headers: { ...admin, origin: ORIGIN },
    data: {},
  });
  expect(res.status()).toBe(200);
  return (await res.json()).data.processed as number;
}

test.describe("트리거 저니", () => {
  test("이벤트로 자동 등록되고, 같은 이벤트가 또 와도 실행은 하나다", async ({ request }) => {
    const p = await createProject(request, "jrn-entry");
    await createJourney(request, p.pid, `entry-${Date.now()}`, BRANCH_JOURNEY);
    await identifyWithDevice(request, p, "jrn-entry-user", {});

    const fire = () =>
      request.post("/api/v1/journeys/event", {
        headers: { "api-key": p.apiKey },
        data: { event: "signup", external_id: "jrn-entry-user", identity_hash: idHash("jrn-entry-user", p.apiSecret) },
      });

    const first = await fire();
    expect(first.status()).toBe(202);
    expect((await first.json()).data).toMatchObject({ enrolled: 1, matched: true });

    // 멱등 — (journey, user) 유니크가 두 번째를 삼킨다. 앱이 이벤트를 재시도해도 저니가 겹치지 않는다.
    const again = await fire();
    expect((await again.json()).data.enrolled).toBe(0);

    // 진입 이름이 아닌 이벤트는 아무 일도 하지 않는다
    const other = await request.post("/api/v1/journeys/event", {
      headers: { "api-key": p.apiKey },
      data: { event: "opened_app", external_id: "jrn-entry-user", identity_hash: idHash("jrn-entry-user", p.apiSecret) },
    });
    expect((await other.json()).data.enrolled).toBe(0);
  });

  test("trigger_events 이전에 저장된 저니도 이벤트로 등록되고, 그 자리에서 컬럼이 채워진다", async ({ request }) => {
    const p = await createProject(request, "jrn-legacy");
    const jid = await createJourney(request, p.pid, `legacy-${Date.now()}`, BRANCH_JOURNEY);
    await identifyWithDevice(request, p, "jrn-legacy-user", {});
    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      // 생성 시점에 파생값이 저장된다
      expect((await sql`select trigger_events from journeys where id = ${jid}`)[0].trigger_events).toEqual(["signup", "purchase"]);
      // 마이그레이션 직후의 기존 행을 흉내 낸다
      await sql`update journeys set trigger_events = null where id = ${jid}`;

      const res = await request.post("/api/v1/journeys/event", {
        headers: { "api-key": p.apiKey },
        data: { event: "signup", external_id: "jrn-legacy-user", identity_hash: idHash("jrn-legacy-user", p.apiSecret) },
      });
      expect((await res.json()).data).toMatchObject({ enrolled: 1, matched: true });
      expect((await sql`select trigger_events from journeys where id = ${jid}`)[0].trigger_events).toEqual(["signup", "purchase"]);
    } finally {
      await sql.end();
    }
  });

  test("진입 이벤트는 identity_hash 없이는 거절된다", async ({ request }) => {
    const p = await createProject(request, "jrn-auth");
    await createJourney(request, p.pid, `auth-${Date.now()}`, BRANCH_JOURNEY);
    await identifyWithDevice(request, p, "jrn-auth-user", {});

    const res = await request.post("/api/v1/journeys/event", {
      headers: { "api-key": p.apiKey },
      data: { event: "signup", external_id: "jrn-auth-user" },
    });
    // 공개 api-key 만으로 남을 저니에 넣거나 끝낼 수 있으면 안 된다
    expect(res.status()).toBe(403);
  });

  test("클릭 창이 안 닫혔으면 분기를 미루고, 클릭이 들어오면 yes 갈래로 간다", async ({ request }) => {
    const p = await createProject(request, "jrn-branch");
    const jid = await createJourney(request, p.pid, `branch-${Date.now()}`, BRANCH_JOURNEY);
    await identifyWithDevice(request, p, "jrn-branch-user", {});

    const enroll = await request.post("/api/v1/journeys/enroll", {
      headers: { "api-key": p.apiKey },
      data: {
        journey: (await (await request.get(`/api/admin/projects/${p.pid}/journeys/${jid}`, { headers: admin })).json()).data
          .journey.name,
        external_id: "jrn-branch-user",
        identity_hash: idHash("jrn-branch-user", p.apiSecret),
      },
    });
    expect(enroll.status()).toBe(201);

    // 1회차: 환영 발송 → 분기로 이동
    expect(await drain(request, p.pid)).toBe(1);
    // 2회차: 분기. 창(1시간)이 안 닫혔고 클릭이 없으니 **미룬다** — 여기서 no 로 떨어지면
    // 아직 누를 시간이 있는 사람이 전부 재촉 갈래로 간다.
    await drain(request, p.pid);

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const [run] = await sql`select current_step, next_run_at, status from journey_runs where journey_id = ${jid}`;
      expect(run.status).toBe("active");
      expect(run.current_step).toBe(1); // 분기 자리에 그대로
      expect(new Date(run.next_run_at).getTime()).toBeGreaterThan(Date.now());

      // 그 발송을 눌렀다고 기록하고 창을 다시 연다
      const [log] = await sql`
        select id from push_logs where project_id = ${p.pid} and sent_by = 'journey'
         order by created_at desc limit 1`;
      const [device] = await sql`select id, user_id from devices where project_id = ${p.pid} limit 1`;
      await sql`
        insert into push_clicks (project_id, log_id, device_id, user_id)
        values (${p.pid}, ${log.id}, ${device.id}, ${device.user_id})`;
      await sql`update journey_runs set next_run_at = now() where journey_id = ${jid}`;

      await drain(request, p.pid);
      const [after] = await sql`select current_step from journey_runs where journey_id = ${jid}`;
      expect(after.current_step).toBe(2); // 2.yes.0 — 고맙습니다 발송
    } finally {
      await sql.end();
    }

    const detail = (await (await request.get(`/api/admin/projects/${p.pid}/journeys/${jid}`, { headers: admin })).json()).data;
    // 스텝별 인원은 빈 갈래까지 전부 나온다 — 0 인 스텝이 빠지면 분기가 있는지도 화면에서 알 수 없다
    expect(Object.keys(detail.stepCounts).sort()).toEqual(["1", "2", "2.no.0", "2.yes.0", "3"]);
    expect(detail.stepCounts["2.yes.0"]).toBe(1);
  });

  test("종료 이벤트가 오면 어느 단계에 있든 저니가 끝난다", async ({ request }) => {
    const p = await createProject(request, "jrn-exit");
    const jid = await createJourney(request, p.pid, `exit-${Date.now()}`, BRANCH_JOURNEY);
    await identifyWithDevice(request, p, "jrn-exit-user", {});
    const hash = idHash("jrn-exit-user", p.apiSecret);

    await request.post("/api/v1/journeys/event", {
      headers: { "api-key": p.apiKey },
      data: { event: "signup", external_id: "jrn-exit-user", identity_hash: hash },
    });
    await drain(request, p.pid); // 환영 발송

    const done = await request.post("/api/v1/journeys/event", {
      headers: { "api-key": p.apiKey },
      data: { event: "purchase", external_id: "jrn-exit-user", identity_hash: hash },
    });
    expect((await done.json()).data.exited).toBe(1);

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const [run] = await sql`select status from journey_runs where journey_id = ${jid}`;
      expect(run.status).toBe("exited");
      // 끝난 실행은 더 이상 도래하지 않는다 — 전환한 사람에게 재촉이 계속 가면 안 된다
      expect(await drain(request, p.pid)).toBe(0);
    } finally {
      await sql.end();
    }

    const detail = (await (await request.get(`/api/admin/projects/${p.pid}/journeys/${jid}`, { headers: admin })).json()).data;
    expect(detail.exitedRuns).toBe(1);
    expect(detail.activeRuns).toBe(0);
  });

  test("서버가 트리 규칙을 거절한다 — 진입 위치·중첩 깊이·이름 없는 종료", async ({ request }) => {
    const p = await createProject(request, "jrn-valid");
    const bad = async (steps: unknown[]) =>
      (
        await request.post(`/api/admin/projects/${p.pid}/journeys`, {
          headers: { ...admin, origin: ORIGIN },
          data: { name: `bad-${Date.now()}-${Math.random()}`, steps },
        })
      ).status();

    // entry 는 맨 앞에서만 읽힌다 — 다른 자리에 두면 안 도는 트리거가 조용히 저장된다
    expect(await bad([{ type: "send", title: "a" }, { type: "entry", event: "signup" }])).toBe(422);
    // 이름 없는 종료 조건은 영원히 걸리지 않는다
    expect(await bad([{ type: "exit" }])).toBe(422);
    // 실행할 스텝이 하나도 없는 저니
    expect(await bad([{ type: "entry", event: "signup" }])).toBe(422);

    let deep: Record<string, unknown> = { type: "send", title: "a" };
    for (let i = 0; i < 4; i++) deep = { type: "branch", withinHours: 1, yes: [deep], no: [] };
    expect(await bad([deep])).toBe(422);
  });
});

test.describe("저니 편집 화면", () => {
  test("분기를 넣으면 새 행으로 초점이 가고, 제목이 비면 그 칸에 오류가 붙는다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    const mk = await page.request.post(`/api/admin/projects/${pid}/journeys`, {
      headers: { origin: ORIGIN },
      data: { name: `ui-journey-${Date.now()}`, steps: [{ type: "send", title: "환영", body: "본문" }] },
    });
    expect(mk.status()).toBe(201);
    const jid = (await mk.json()).data.journey.id as string;

    await page.goto(`/projects/${pid}/journeys/${jid}`);
    await page.getByRole("button", { name: "분기 추가" }).first().click();

    // 새 행의 첫 입력칸으로 간다 — 추가 버튼에 초점이 남으면 어디에 쓰는지 알 수 없다
    const added = page.getByRole("group", { name: "스텝 2" });
    await expect(added.getByLabel("스텝 타입")).toBeFocused();
    // "눌렀다면" 은 "안 눌렀다면" 의 부분 문자열이라 exact 없이는 두 갈래가 같은 것으로 잡힌다
    await expect(added.getByText("눌렀다면", { exact: true })).toBeVisible();
    await expect(added.getByText("안 눌렀다면", { exact: true })).toBeVisible();

    // 갈래 안에 발송을 넣고 제목을 비운 채 저장하면 그 칸 아래에 오류가 붙는다
    await added.getByRole("button", { name: "send 추가" }).first().click();
    await page.getByRole("button", { name: "저장" }).click();
    const inner = page.getByRole("group", { name: "스텝 1" }).last();
    const title = inner.getByLabel("제목");
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).toBeFocused();
    await expect(page.getByText("제목을 입력하세요")).toBeVisible();

    // 지우면 초점이 사라지지 않고 앞 행으로 돌아온다
    // 분기 스텝은 갈래 안에 **자기 스텝들**을 품는다 — 그 아이들의 삭제 단추도 같은 그룹 안에 있다.
    // 지우려는 것은 분기 행 자신이고, 그 단추는 머리글에 있어 DOM 상 아이들보다 앞선다.
    await added.getByRole("button", { name: "스텝 삭제" }).first().click();
    await expect(page.getByRole("group", { name: "스텝 2" })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "스텝 1" }).getByLabel("스텝 타입")).toBeFocused();
  });
});

// ─── A/B 자동 승자 ───────────────────────────────────────────────────────────

test.describe("A/B 자동 승자", () => {
  const VARIANTS = [
    { title: "A 제목", body: "A 본문" },
    { title: "B 제목", body: "B 본문" },
  ];

  /** 기기 n대 등록(사람 없이) — 토큰 해시로 갈리므로 사람은 필요 없다 */
  async function registerDevices(request: APIRequestContext, apiKey: string, prefix: string, n: number) {
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        request.post("/api/v1/devices", {
          headers: { "api-key": apiKey },
          data: { token: `${prefix}-${i}-${Date.now()}`, platform: "android" },
        })
      )
    );
  }

  test("ab_test 는 변형이 있어야 하고 단건 발송에는 쓸 수 없다", async ({ request }) => {
    const p = await createProject(request, "ab-validate");
    const headers = { "api-key": p.apiKey, "api-secret": p.apiSecret };
    const send = (data: Record<string, unknown>) => request.post("/api/v1/messages", { headers, data });

    // 변형이 없으면 비교할 것이 없다
    const noVariants = await send({ title: "t", body: "b", type: "broadcast", ab_test: { sample_percent: 20, wait_minutes: 60 } });
    expect(noVariants.status()).toBe(422);
    expect((await noVariants.json()).error).toContain("variants");

    // 한 사람에게 가는 발송은 표본과 나머지로 가를 수 없다 — 한쪽이 0명이 된다
    await identifyWithDevice(request, p, "ab-one", {});
    const single = await send({
      title: "t", body: "b", type: "single", target: "ab-one", variants: VARIANTS,
      ab_test: { sample_percent: 20, wait_minutes: 60 },
    });
    expect(single.status()).toBe(422);

    // 범위를 벗어난 값은 스키마가 막는다
    expect((await send({ title: "t", body: "b", type: "broadcast", variants: VARIANTS, ab_test: { sample_percent: 90, wait_minutes: 60 } })).status()).toBe(422);
    expect((await send({ title: "t", body: "b", type: "broadcast", variants: VARIANTS, ab_test: { sample_percent: 20, wait_minutes: 1 } })).status()).toBe(422);

    const ok = await send({ title: "t", body: "b", type: "broadcast", variants: VARIANTS, ab_test: { sample_percent: 20, wait_minutes: 60 } });
    expect(ok.status()).toBe(202);
    const id = (await ok.json()).data.message.id as string;

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const rows = await sql`select ab_test from push_logs where id = ${id}`;
      // 지표는 고정이라 요청으로 받지 않고 서버가 채운다
      expect(rows[0].ab_test).toEqual({ role: "test", samplePercent: 20, waitMinutes: 60, metric: "unique_click_rate" });
    } finally {
      await sql.end();
    }
  });

  test("표본에 먼저 보내고 판정 시각까지 기다린다 — 승자 본발송은 표본과 겹치지 않는다", async ({ request }) => {
    const p = await createProject(request, "ab-split");
    const DEVICES = 20;
    await registerDevices(request, p.apiKey, "ab-split", DEVICES);

    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: { title: "A 제목", body: "A 본문", type: "broadcast", variants: VARIANTS, ab_test: { sample_percent: 50, wait_minutes: 30 } },
    });
    expect(res.status()).toBe(202);
    const sampleId = (await res.json()).data.message.id as string;
    const process = () => request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    await process();

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      const [sample] = await sql`select status, total_count, ab_test from push_logs where id = ${sampleId}`;
      // 표본만 나갔다. 판정이 남았으므로 아직 닫지 않고, 언제 정할지를 적어 둔다.
      expect(sample.status).toBe("processing");
      expect(sample.ab_test.decideAt).toBeTruthy();
      expect(sample.ab_test.decision).toBeUndefined();
      const sampleSent = Number(sample.total_count);
      expect(sampleSent).toBeGreaterThan(0);
      expect(sampleSent).toBeLessThan(DEVICES);

      // 스캔이 다시 집어도 판정 시각 전에는 아무 일도 하지 않는다
      await process();
      const [early] = await sql`select status, ab_test from push_logs where id = ${sampleId}`;
      expect(early.status).toBe("processing");
      expect(early.ab_test.decision).toBeUndefined();

      // 최소 표본을 채운 결과를 심고(B 가 뚜렷이 높다) 판정 시각을 앞당긴다.
      // locked_at 을 되돌려 놓아야 stale 재클레임 조건에 걸린다 — 반납이 하는 일과 같다.
      const devices = await sql`select id from devices where project_id = ${p.pid} limit 14`;
      await sql`
        update push_logs set
          resume_cursor = jsonb_set(resume_cursor::jsonb, '{variantStats}',
            '{"0":{"sent":150,"success":150},"1":{"sent":150,"success":150}}'::jsonb)::text,
          ab_test = jsonb_set(ab_test, '{decideAt}', to_jsonb((now() - interval '1 minute')::text)),
          locked_at = now() - interval '10 minutes'
        where id = ${sampleId}`;
      for (const [i, d] of devices.entries()) {
        await sql`insert into push_clicks (project_id, log_id, device_id, variant)
                  values (${p.pid}, ${sampleId}, ${d.id}, ${i < 2 ? 0 : 1})`;
      }

      await process();
      const [decided] = await sql`select status, ab_test from push_logs where id = ${sampleId}`;
      expect(decided.status).toBe("logged"); // 크레덴셜이 없는 환경이라 로그 전용으로 닫힌다
      expect(decided.ab_test.decision.winner).toBe(1);
      expect(decided.ab_test.decision.reason).toBe("winner");
      const winnerId = decided.ab_test.decision.followUpLogId as string;
      expect(winnerId).toBeTruthy();

      const [winner] = await sql`select title, variants, ab_test, sent_by from push_logs where id = ${winnerId}`;
      expect(winner.title).toBe("B 제목");
      expect(winner.variants).toBeNull(); // 본발송은 승자 하나로만 나간다
      expect(winner.sent_by).toBe("ab-winner");
      expect(winner.ab_test).toEqual({ role: "winner", parentLogId: sampleId, samplePercent: 50, variant: 1 });

      // 승자 본발송을 내보낸다. 표본과 합이 정확히 전체 기기 수다 —
      // 앞에서 N행으로 잘랐다면 여기서 합이 넘어(같은 사람이 두 번 받아) 무너진다.
      await process();
      const [sent] = await sql`select status, total_count from push_logs where id = ${winnerId}`;
      expect(sent.status).toBe("logged");
      expect(Number(sent.total_count)).toBe(DEVICES - sampleSent);

      // 판정을 다시 돌려도 본발송은 한 행뿐이다(멱등 키)
      const rows = await sql`select count(*)::int as n from push_logs where project_id = ${p.pid} and sent_by = 'ab-winner'`;
      expect(rows[0].n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  test("표본이 작으면 승자를 고르지 않고 이유를 남긴다", async ({ request }) => {
    const p = await createProject(request, "ab-tiny");
    await registerDevices(request, p.apiKey, "ab-tiny", 6);
    const res = await request.post("/api/v1/messages", {
      headers: { "api-key": p.apiKey, "api-secret": p.apiSecret },
      data: { title: "A 제목", body: "A 본문", type: "broadcast", variants: VARIANTS, ab_test: { sample_percent: 50, wait_minutes: 5 } },
    });
    const id = (await res.json()).data.message.id as string;
    const process = () => request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    await process();

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      await sql`
        update push_logs set
          ab_test = jsonb_set(ab_test, '{decideAt}', to_jsonb((now() - interval '1 minute')::text)),
          locked_at = now() - interval '10 minutes'
        where id = ${id}`;
      await process();

      const [row] = await sql`select ab_test from push_logs where id = ${id}`;
      // 조용히 A 를 고르지 않는다 — 그러면 아무것도 재지 않고 A/B 를 했다고 믿게 된다
      expect(row.ab_test.decision.winner).toBeNull();
      expect(row.ab_test.decision.reason).toBe("insufficient_sample");
      expect(row.ab_test.decision.followUpLogId).toBeUndefined();
      const rest = await sql`select count(*)::int as n from push_logs where project_id = ${p.pid} and sent_by = 'ab-winner'`;
      expect(rest[0].n).toBe(0);
    } finally {
      await sql.end();
    }
  });

  test("발송 화면: 변형을 더하면 A/B 자동 승자 칸이 열리고 값이 본문으로 실린다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.goto(`/projects/${pid}/send/broadcast`);

    // 변형이 없으면 잴 것이 없으므로 칸도 없다
    await expect(page.getByLabel("A/B 자동 승자")).toHaveCount(0);
    await page.getByRole("button", { name: "변형 B 추가" }).click();
    await page.getByLabel("변형 B 제목").fill("B 제목");
    await page.getByLabel("변형 B 본문").fill("B 본문");
    await page.getByLabel("A/B 자동 승자").check();

    // 범위 밖 값은 그 칸 옆에 붙는다
    await page.getByLabel("표본 비율(%)").fill("90");
    await expect(page.getByText("표본 비율은 5~50 사이의 정수여야 합니다")).toBeVisible();
    await page.getByLabel("제목", { exact: true }).fill("A 제목");
    await page.getByLabel("본문", { exact: true }).fill("A 본문");
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await expect(page.getByText("A/B 자동 승자 설정에 잘못된 값이 있습니다")).toBeVisible();

    await page.getByLabel("표본 비율(%)").fill("15");
    await page.getByLabel("판정 대기(분)").fill("120");

    let posted: Record<string, unknown> = {};
    await page.route(`**/api/admin/projects/${pid}/messages`, async (route) => {
      posted = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ data: { message: { id: "stub" } } }) });
    });
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await page.getByRole("dialog").getByRole("button", { name: /발송/ }).click();
    await expect.poll(() => Object.keys(posted).length).toBeGreaterThan(0);
    expect(posted.ab_test).toEqual({ sample_percent: 15, wait_minutes: 120 });
    expect(posted.variants).toHaveLength(2);
  });

  test("템플릿 덮어쓰기는 브라우저 confirm 이 아니라 콘솔 다이얼로그로 묻는다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    const name = `덮어쓰기-${Date.now()}`;
    await page.request.post(`/api/admin/projects/${pid}/templates`, {
      headers: { origin: ORIGIN },
      data: { name, title: "템플릿 제목", body: "템플릿 본문" },
    });

    await page.goto(`/projects/${pid}/send/broadcast`);
    await page.getByLabel("제목", { exact: true }).fill("쓰던 제목");
    await page.getByLabel("템플릿").selectOption({ label: name });

    // 버튼 글자가 브라우저 언어가 아니라 화면 언어다
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "취소" })).toBeVisible();
    await dialog.getByRole("button", { name: "취소" }).click();
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue("쓰던 제목");
    // 확인 다이얼로그 이름이 "템플릿 적용" 이라 부분 일치로는 창까지 잡힌다 — 고르기 칸만 본다
    await expect(page.getByLabel("템플릿", { exact: true })).toHaveValue("");

    await page.getByLabel("템플릿", { exact: true }).selectOption({ label: name });
    await page.getByRole("dialog").getByRole("button", { name: "적용" }).click();
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue("템플릿 제목");
    // 고른 템플릿과 화면의 선택이 어긋나지 않는다
    await expect(page.getByLabel("템플릿", { exact: true })).not.toHaveValue("");
  });
});

test.describe("감사 로그와 리포트 내보내기", () => {
  test("설정 변경이 누가·무엇에서 무엇으로 바뀌었는지까지 남는다", async ({ request }) => {
    const p = await createProject(request, "audit-settings");

    // 방해금지는 시작·끝을 함께 정해야 켜진다 — 한쪽만 보내면 422
    expect((await request.patch(`/api/admin/projects/${p.pid}`, { headers: admin, data: { quiet_start_hour: 22 } })).status()).toBe(422);
    await request.patch(`/api/admin/projects/${p.pid}`, { headers: admin, data: { quiet_start_hour: 22, quiet_end_hour: 7 } });
    await request.patch(`/api/admin/projects/${p.pid}`, { headers: admin, data: { quiet_start_hour: 23 } });
    // 같은 값으로 다시 저장한 요청은 기록하지 않는다 — 잡음이 쌓이면 진짜 변경을 못 찾는다
    await request.patch(`/api/admin/projects/${p.pid}`, { headers: admin, data: { quiet_start_hour: 23 } });

    const res = await request.get(`/api/admin/projects/${p.pid}/audit?action=project.settings.update`, { headers: admin });
    expect(res.ok()).toBeTruthy();
    const entries = (await res.json()).data.entries as Array<{
      action: string;
      actorLabel: string;
      diff: Record<string, { before: unknown; after: unknown }> | null;
    }>;

    expect(entries).toHaveLength(2);
    // 최신순 — 23 으로 바꾼 것이 위
    expect(entries[0].diff?.quietStartHour).toEqual({ before: 22, after: 23 });
    expect(entries[1].diff?.quietStartHour).toEqual({ before: null, after: 22 });
    expect(entries[0].actorLabel).toBe("admin-token");
  });

  test("인증 없는 쓰기와 타 org 404 는 감사에 적지 않는다", async ({ request }) => {
    const p = await createProject(request, "audit-denied");

    // 토큰 없는 쓰기 → 401. 적으면 누구나 감사 테이블에 행을 밀어 넣을 수 있다.
    const anon = await request.patch(`/api/admin/projects/${p.pid}`, {
      headers: { origin: ORIGIN },
      data: { quiet_start_hour: 1 },
    });
    expect([401, 403, 404]).toContain(anon.status());

    const res = await request.get(`/api/admin/projects/${p.pid}/audit`, { headers: admin });
    const entries = (await res.json()).data.entries as Array<{ action: string }>;
    expect(entries.some((e) => e.action.endsWith(":denied"))).toBe(false);
  });

  test("가져오기 배치를 통째로 되돌린다 (두 번은 안 된다)", async ({ request }) => {
    const p = await createProject(request, "audit-batch");

    // 먼저 손으로 하나 넣어 둔다 — 되돌리기가 이 행까지 건드리면 안 된다
    const manual = await request.post(`/api/admin/projects/${p.pid}/audience/suppressions`, {
      headers: admin,
      data: { user_id: "already-blocked", reason: "opt_out" },
    });
    expect(manual.status()).toBe(201);

    const imp = await request.post(`/api/admin/projects/${p.pid}/audience/suppressions/import`, {
      headers: { ...admin, "content-type": "text/csv" },
      data: "user_id,reason\nbulk-a,manual\nbulk-b,manual\nalready-blocked,manual\n",
    });
    expect(imp.ok()).toBeTruthy();
    const impBody = (await imp.json()).data;
    expect(impBody.added).toBe(2); // 이미 있던 대상은 건너뛴다
    const batchId = impBody.batch_id as string;
    expect(batchId).toBeTruthy();

    // 배치 id 가 감사에 남아 있다
    const auditRes = await request.get(`/api/admin/projects/${p.pid}/audit?action=suppression.import`, { headers: admin });
    const impEntry = (await auditRes.json()).data.entries[0];
    expect(impEntry.targetId).toBe(batchId);
    expect(impEntry.diff.added).toEqual({ before: 0, after: 2 });

    const revert = await request.post(`/api/admin/projects/${p.pid}/audience/suppressions/import/revert`, {
      headers: { ...admin, "content-type": "application/json" },
      data: { batch_id: batchId },
    });
    expect(revert.ok()).toBeTruthy();
    expect((await revert.json()).data.removed).toBe(2);

    const left = await request.get(`/api/admin/projects/${p.pid}/audience/suppressions`, { headers: admin });
    const ids = ((await left.json()).data.suppressions as Array<{ externalId: string | null }>).map((s) => s.externalId);
    expect(ids).toEqual(["already-blocked"]); // 원래 있던 수신거부는 살아 있다

    const again = await request.post(`/api/admin/projects/${p.pid}/audience/suppressions/import/revert`, {
      headers: { ...admin, "content-type": "application/json" },
      data: { batch_id: batchId },
    });
    expect(again.status()).toBe(409);
  });

  test("diff 에 토큰과 전화번호가 남지 않는다", async ({ request }) => {
    const p = await createProject(request, "audit-redact");
    const token = `secret-token-${Date.now()}`;

    await request.post(`/api/admin/projects/${p.pid}/audience/suppressions`, {
      headers: admin,
      data: { token, reason: "bounced" },
    });
    await request.post(`/api/admin/projects/${p.pid}/audience/suppressions`, {
      headers: admin,
      data: { user_id: "+821012345678", reason: "opt_out" },
    });

    const res = await request.get(`/api/admin/projects/${p.pid}/audit?action=suppression.create`, { headers: admin });
    const raw = JSON.stringify((await res.json()).data.entries);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("821012345678");
    expect(raw).toContain("[redacted]");
    expect(raw).toContain("[phone …5678]");
  });

  test("CSV 내보내기는 화면에 건 필터와 같은 범위만 담는다", async ({ request }) => {
    const p = await createProject(request, "audit-export");
    await request.patch(`/api/admin/projects/${p.pid}`, { headers: admin, data: { quiet_start_hour: 3, quiet_end_hour: 6 } });
    await request.post(`/api/admin/projects/${p.pid}/audience/topics`, { headers: admin, data: { name: `export-topic-${Date.now()}` } });

    const all = await request.get(`/api/admin/projects/${p.pid}/export/audit`, { headers: admin });
    expect(all.ok()).toBeTruthy();
    expect(all.headers()["content-type"]).toContain("text/csv");
    expect(all.headers()["x-export-row-limit"]).toBe("50000");
    const allText = await all.text();
    expect(allText.startsWith("﻿")).toBe(true); // 엑셀이 한글을 깨뜨리지 않게
    expect(allText).toContain("project.settings.update");
    expect(allText).toContain("topic.create");

    // 화면에서 토픽 생성만 보고 있으면 파일에도 그것만 담겨야 한다
    const filtered = await request.get(`/api/admin/projects/${p.pid}/export/audit?action=topic.create`, { headers: admin });
    const filteredText = await filtered.text();
    expect(filteredText).toContain("topic.create");
    expect(filteredText).not.toContain("project.settings.update");

    // 범위 밖 기간이면 헤더만 남는다
    const empty = await request.get(`/api/admin/projects/${p.pid}/export/audit?from=2000-01-01&to=2000-01-02`, { headers: admin });
    expect((await empty.text()).trimEnd().split("\r\n")).toHaveLength(1);
  });

  test("감사 화면: 최신순 목록과 행위 필터, 내보내기 단추", async ({ page }) => {
    await ensureLogin(page);
    const pid = await sessionProjectId(page);
    await page.request.patch(`/api/admin/projects/${pid}`, { headers: { origin: ORIGIN }, data: { quiet_start_hour: Date.now() % 6, quiet_end_hour: 7 } });

    await page.goto(`/projects/${pid}/audit`);
    await expect(page.getByRole("heading", { name: "감사 로그" })).toBeVisible();
    await expect(page.getByRole("table", { name: "감사 로그" })).toBeVisible();
    // 같은 이름이 행위 필터의 <option> 에도 있다 — 목록에 정말 남았는지는 표 안에서 본다
    await expect(page.getByRole("table", { name: "감사 로그" }).getByText("프로젝트 설정 변경").first()).toBeVisible();

    // 필터는 조회와 내보내기에 함께 걸린다
    // "행위" 는 "행위자" 의 부분 문자열이라 exact 없이는 두 드롭다운이 함께 잡힌다
    await page.getByLabel("행위", { exact: true }).selectOption("topic.create");
    await expect(page.getByRole("link", { name: "감사 로그 CSV" })).toHaveAttribute("href", /action=topic\.create/);

    // 시작일이 종료일보다 뒤면 그 칸 옆에 이유가 붙는다
    await expect(page.getByRole("link", { name: "발송 로그 CSV" })).toBeVisible();
    await expect(page.getByRole("link", { name: "참여 CSV" })).toHaveAttribute("href", /range=30d/);
  });
});

test.describe("발송 취소 · 로케일 문구 · 홀드아웃 · 수신 보고 · 캠페인별 재정의", () => {
  const sdk = (p: { apiKey: string; apiSecret: string }) => ({ "api-key": p.apiKey, "api-secret": p.apiSecret });

  async function queue(request: APIRequestContext, p: { apiKey: string; apiSecret: string }, data: Record<string, unknown>) {
    const res = await request.post("/api/v1/messages", { headers: sdk(p), data });
    expect(res.status()).toBe(202);
    return (await res.json()).data.message.id as string;
  }

  async function registerDevice(request: APIRequestContext, p: { apiKey: string }, token: string, locale?: string) {
    const res = await request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android", ...(locale ? { locale } : {}) },
    });
    expect(res.ok()).toBeTruthy();
  }

  test("취소: 큐에서 빼고 이미 나간 수를 함께 돌려준다 — 두 번째 취소는 409", async ({ request }) => {
    const p = await createProject(request, "cancel");
    const id = await queue(request, p, { type: "broadcast", title: "멈출 발송", body: "본문" });

    const res = await request.post(`/api/admin/projects/${p.pid}/logs/${id}/cancel`, { headers: { ...admin, origin: ORIGIN }, data: {} });
    expect(res.status()).toBe(200);
    const log = (await res.json()).data.log;
    expect(log.status).toBe("canceled");
    expect(log.canceled_at).not.toBeNull();
    // "취소됨"만 보여 주면 아무에게도 안 갔다고 읽는다 — 이미 나간 수를 반드시 준다
    expect(log.sent).toEqual({ total: 0, success: 0, failure: 0, holdout: 0 });

    // 큐를 돌려도 취소된 로그는 집히지 않는다(클레임 조건에 canceled 가 없다)
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    const detail = await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin });
    expect((await detail.json()).data.log.status).toBe("canceled");

    const again = await request.post(`/api/admin/projects/${p.pid}/logs/${id}/cancel`, { headers: { ...admin, origin: ORIGIN }, data: {} });
    expect(again.status()).toBe(409);
  });

  test("취소: 끝난 발송은 409, 없는 발송은 404", async ({ request }) => {
    const p = await createProject(request, "cancel-done");
    const id = await queue(request, p, { type: "broadcast", title: "끝난 발송", body: "본문" });
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });

    const done = await request.post(`/api/admin/projects/${p.pid}/logs/${id}/cancel`, { headers: { ...admin, origin: ORIGIN }, data: {} });
    expect(done.status()).toBe(409);
    const missing = await request.post(
      `/api/admin/projects/${p.pid}/logs/00000000-0000-0000-0000-000000000000/cancel`,
      { headers: { ...admin, origin: ORIGIN }, data: {} }
    );
    expect(missing.status()).toBe(404);
  });

  test("로케일 문구: 저장되고 폴백 인원이 로케일별로 남는다", async ({ request }) => {
    const p = await createProject(request, "locale");
    const stamp = Date.now();
    await registerDevice(request, p, `loc-ko-${stamp}`, "ko_KR"); // 밑줄 표기도 ko 로 접힌다
    await registerDevice(request, p, `loc-fr-${stamp}`, "fr-CA"); // 맞는 언어가 없다 → 폴백
    await registerDevice(request, p, `loc-none-${stamp}`); // 로케일 미상 → "" 로 센다

    const locales = { ko: { title: "세일 시작", body: "최대 50% 할인" } };
    const id = await queue(request, p, { type: "broadcast", title: "Sale", body: "50% off", locales });
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });

    const detail = await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin });
    const log = (await detail.json()).data.log;
    expect(log.localeVariants).toEqual(locales);
    // 조용한 폴백은 믿을 수 없다 — 몇 명이 무슨 로케일로 기본 문구를 받았는지 보여야 한다
    expect(log.localeFallbacks.total).toBe(2);
    expect(log.localeFallbacks.byLocale).toMatchObject({ "fr-ca": 1, "": 1 });
  });

  test("로케일 문구: 변형과 함께 쓰거나 기본 문구가 없으면 422", async ({ request }) => {
    const p = await createProject(request, "locale-bad");
    const locales = { ko: { title: "안녕", body: "반가워" } };
    const bad: Array<Record<string, unknown>> = [
      { type: "broadcast", title: "a", body: "b", locales, variants: [{ title: "A", body: "a" }, { title: "B", body: "b" }] },
      { type: "broadcast", locales },
      { type: "broadcast", title: "a", body: "b", locales: { 한국어: { title: "a", body: "b" } } },
      { type: "broadcast", title: "a", body: "b", locales: { ko_KR: { title: "a", body: "b" }, "ko-KR": { title: "c", body: "d" } } },
    ];
    for (const data of bad) {
      const res = await request.post("/api/v1/messages", { headers: sdk(p), data });
      expect(res.status()).toBe(422);
    }
  });

  test("홀드아웃: 대조군을 빼고 명단을 남긴다 — 같은 사람은 발송이 바뀌어도 같은 쪽", async ({ request }) => {
    const p = await createProject(request, "holdout");
    const stamp = Date.now();
    for (let i = 0; i < 60; i++) await registerDevice(request, p, `hold-${stamp}-${i}`);

    const first = await queue(request, p, { type: "broadcast", title: "캠페인 1", body: "본문", holdout_percent: 50 });
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });
    const second = await queue(request, p, { type: "broadcast", title: "캠페인 2", body: "본문", holdout_percent: 50 });
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });

    const sql = postgres(E2E_DATABASE_URL, { max: 1 });
    try {
      // 발송군(held=false)도 남는다 — 대조군 명단은 held=true 만
      const held = await sql`select log_id, device_id from push_holdouts where project_id = ${p.pid} and held`;
      const treated = await sql`select count(*)::int as n from push_holdouts where project_id = ${p.pid} and not held`;
      expect(treated[0].n).toBeGreaterThan(0);
      const a = new Set(held.filter((r) => r.log_id === first).map((r) => r.device_id));
      const b = new Set(held.filter((r) => r.log_id === second).map((r) => r.device_id));
      expect(a.size).toBeGreaterThan(0);
      // 발송마다 다시 뽑으면 재는 것이 "푸시의 효과"가 아니라 "그날 누가 뽑혔는가"가 된다
      expect([...b].sort()).toEqual([...a].sort());
      const logs = await sql`select holdout_percent, holdout_count from push_logs where id = ${first}`;
      expect(logs[0].holdout_percent).toBe(50);
      expect(Number(logs[0].holdout_count)).toBe(a.size);
    } finally {
      await sql.end();
    }

    const detail = await request.get(`/api/admin/projects/${p.pid}/logs/${first}`, { headers: admin });
    const body = (await detail.json()).data;
    expect(body.holdout.percent).toBe(50);
    expect(body.holdout.devices).toBeGreaterThan(0);
    // 대조군 전환이 0 이면 비율이 성립하지 않는다 — 0% 나 무한대로 적지 않는다
    expect(body.holdout.lift).toBeNull();
  });

  test("홀드아웃: type=single 은 422", async ({ request }) => {
    const p = await createProject(request, "holdout-single");
    const res = await request.post("/api/v1/messages", {
      headers: sdk(p),
      data: { type: "single", target: "u1", title: "a", body: "b", holdout_percent: 10 },
    });
    expect(res.status()).toBe(422);
  });

  test("수신 보고: 도달 수를 FCM 접수와 다른 칸에 세고, 재보고는 한 번만 센다", async ({ request }) => {
    const p = await createProject(request, "receipt");
    const token = `rcpt-${Date.now()}`;
    await registerDevice(request, p, token);
    const id = await queue(request, p, { type: "broadcast", title: "도달 확인", body: "본문" });
    await request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: admin, data: {} });

    const first = await request.post("/api/v1/messages/received", {
      headers: { "api-key": p.apiKey },
      data: { log_id: id, token },
    });
    expect(first.status()).toBe(202);
    expect((await first.json()).data.recorded).toBe(true);

    // (발송, 기기) 유니크 — SDK 가 재시도해도 카운터가 부풀지 않는다
    const again = await request.post("/api/v1/messages/received", {
      headers: { "api-key": p.apiKey },
      data: { log_id: id, token },
    });
    expect((await again.json()).data.recorded).toBe(false);

    const detail = await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin });
    expect((await detail.json()).data.log.deliveredCount).toBe(1);
  });

  test("수신 보고: 키·기기·발송 자격을 가린다", async ({ request }) => {
    const p = await createProject(request, "receipt-auth");
    const token = `rcpt-auth-${Date.now()}`;
    await registerDevice(request, p, token);
    const id = await queue(request, p, { type: "broadcast", title: "a", body: "b" });

    const noKey = await request.post("/api/v1/messages/received", { data: { log_id: id, token } });
    expect(noKey.status()).toBe(401);

    const headers = { "api-key": p.apiKey };
    const badBody = await request.post("/api/v1/messages/received", { headers, data: { log_id: "not-a-uuid", token } });
    expect(badBody.status()).toBe(422);

    const noLog = await request.post("/api/v1/messages/received", {
      headers,
      data: { log_id: "00000000-0000-0000-0000-000000000000", token },
    });
    expect(noLog.status()).toBe(404);

    const noDevice = await request.post("/api/v1/messages/received", { headers, data: { log_id: id, token: "없는-토큰" } });
    expect(noDevice.status()).toBe(404);
  });

  test("캠페인별 재정의: quiet_hours:false 는 방해금지를 건너뛰고, 속도 제한을 발송 단위로 덮는다", async ({ request }) => {
    const p = await createProject(request, "override");
    // 하루 전체가 방해금지인 프로젝트 — 재정의가 없으면 반드시 미뤄진다
    const patch = await request.patch(`/api/admin/projects/${p.pid}`, {
      headers: { ...admin, origin: ORIGIN },
      data: { quiet_start_hour: 0, quiet_end_hour: 23, max_sends_per_minute: 1 },
    });
    expect(patch.ok()).toBeTruthy();

    const quiet = await request.post("/api/v1/messages", { headers: sdk(p), data: { type: "broadcast", title: "마케팅", body: "본문" } });
    expect((await quiet.json()).data.message.status).toBe("scheduled");

    const txn = await request.post("/api/v1/messages", {
      headers: sdk(p),
      data: { type: "broadcast", title: "주문 확인", body: "결제됐습니다", quiet_hours: false, max_sends_per_minute: 0 },
    });
    // 거래성 발송이 마케팅용 야간 금지에 밀리지 않는다
    expect((await txn.json()).data.message.status).toBe("queued");
    const id = (await (await request.get(`/api/admin/projects/${p.pid}/logs`, { headers: admin })).json()).data.logs[0].id;

    const detail = await request.get(`/api/admin/projects/${p.pid}/logs/${id}`, { headers: admin });
    const log = (await detail.json()).data.log;
    expect(log.ignoreQuietHours).toBe(true);
    // 0 과 "주지 않음"은 다르다 — 0 은 이 발송만 제한 없음이라는 명시적 해제다
    expect(log.maxSendsPerMinute).toBe(0);
  });
});

/**
 * 라운드 5 콘솔 배선.
 *
 * 서버가 돌려주는 값을 화면이 실제로 **보여 주는지** 만 본다. 여기서 꼭 지켜보는 것:
 *  - 취소가 "취소됨" 만 말하지 않고 **이미 나간 수**를 함께 말하는가
 *  - 로케일 폴백 인원이 화면에 나오는가(조용한 폴백은 믿을 수 없다)
 *  - 단말 수신이 FCM 접수와 **다른 칸**에 서 있는가
 */
test.describe("라운드 5 콘솔: 취소 · 로케일 · 대조군 · 수신 보고", () => {
  const sdk = (p: { apiKey: string; apiSecret: string }) => ({ "api-key": p.apiKey, "api-secret": p.apiSecret });

  async function seed(page: Page, prefix: string) {
    await ensureLogin(page);
    const created = await page.request.post("/api/admin/projects", {
      data: { name: `${prefix}-${Date.now()}` },
      headers: { origin: ORIGIN },
    });
    expect(created.status()).toBe(201);
    const j = (await created.json()).data;
    return { pid: j.project.id as string, apiKey: j.project.apiKey as string, apiSecret: j.api_secret as string };
  }

  test("큐 화면: 취소는 확인 창을 거치고, 이미 나간 수를 함께 알린다", async ({ page }) => {
    const p = await seed(page, "cancel-ui");
    const queued = await page.request.post("/api/v1/messages", {
      headers: sdk(p),
      data: { type: "broadcast", title: "멈출 캠페인", body: "본문" },
    });
    expect(queued.status()).toBe(202);

    await page.goto(`/projects/${p.pid}/queue`);
    await expect(page.getByText("멈출 캠페인")).toBeVisible();

    // 네이티브 confirm() 이 아니라 콘솔 다이얼로그다 — 브라우저 언어의 OK/Cancel 이 섞이지 않는다
    await page.getByRole("button", { name: "멈출 캠페인 발송 취소" }).click();
    const dialog = page.getByRole("dialog", { name: "이 발송을 취소할까요?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "취소하기" }).click();

    // "취소됨" 만 보여 주면 아무에게도 안 갔다고 읽는다 — 나간 수를 함께 말한다
    await expect(page.getByText("발송을 취소했습니다")).toBeVisible();
    await expect(page.getByText(/취소 시점까지 0건이 나갔습니다/)).toBeVisible();
    await expect(page.getByText("멈출 캠페인")).toHaveCount(0);

    // 상세는 취소 시각·취소한 사람과 나간 수를 남긴다
    const list = await page.request.get(`/api/admin/projects/${p.pid}/logs`, { headers: { origin: ORIGIN } });
    const id = (await list.json()).data.logs[0].id as string;
    await page.goto(`/projects/${p.pid}/logs/${id}`);
    await expect(page.getByText("취소됨")).toBeVisible();
    await expect(page.getByRole("heading", { name: "취소 시점까지 나간 수" })).toBeVisible();
    await expect(page.getByText("취소한 사람")).toBeVisible();
    // 끝난 발송은 되돌릴 것이 없으므로 취소 단추가 서 있지 않다
    await expect(page.getByRole("button", { name: "발송 취소" })).toHaveCount(0);
  });

  test("로그 상세: 로케일 폴백 인원·대조군·단말 수신이 접수와 따로 보인다", async ({ page }) => {
    const p = await seed(page, "detail-ui");
    const stamp = Date.now();
    // 대조군에 뽑히는 기기는 문구를 배정받지 않는다 — 비율을 낮추고 기기를 늘려
    // "폴백이 0 건" 으로 흘러가지 않게 한다(버킷은 토큰 해시라 한두 대로는 흔들린다)
    const devices = [[`ui-ko-${stamp}`, "ko_KR"], ...Array.from({ length: 5 }, (_, i) => [`ui-fr-${i}-${stamp}`, "fr-CA"])] as const;
    for (const [token, locale] of devices) {
      const res = await page.request.post("/api/v1/devices", {
        headers: { "api-key": p.apiKey },
        data: { token, platform: "android", locale },
      });
      expect(res.ok()).toBeTruthy();
    }

    const sent = await page.request.post("/api/v1/messages", {
      headers: sdk(p),
      data: {
        type: "broadcast",
        title: "Sale",
        body: "50% off",
        locales: { ko: { title: "세일 시작", body: "최대 50% 할인" } },
        holdout_percent: 10,
      },
    });
    expect(sent.status()).toBe(202);
    const id = (await sent.json()).data.message.id as string;
    await page.request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: { origin: ORIGIN }, data: {} });

    await page.goto(`/projects/${p.pid}/logs/${id}`);
    // 접수와 수신은 다른 줄이다 — 한 칸에 합치면 기기가 꺼져 있어도 "닿았다" 로 읽힌다
    await expect(page.getByText("단말 수신")).toBeVisible();
    await expect(page.getByText("FCM 접수와 다른 축")).toBeVisible();

    await expect(page.getByRole("heading", { name: "로케일별 문구" })).toBeVisible();
    // 폴백을 숨기면 "번역을 넣었다" 는 믿음만 남는다
    await expect(page.getByText(/명이 기본 문구를 받았습니다/)).toBeVisible();
    await expect(page.getByText("세일 시작")).toBeVisible();

    await expect(page.getByRole("heading", { name: "홀드아웃(대조군)" })).toBeVisible();
    // 분모가 다른 건수 네 개가 아니라, 같은 종류의 **비율** 둘이 나란히 있어야 비교가 된다
    await expect(page.getByText("대조군 전환율")).toBeVisible();
    await expect(page.getByText("발송군 전환율")).toBeVisible();
    await expect(page.getByText(/푸시를 받지 않은 10% 입니다/)).toBeVisible();
    // 대조군 전환이 없으면 리프트는 0% 가 아니라 "잴 수 없음" 이다
    await expect(page.getByText(/리프트를 낼 수 없습니다/)).toBeVisible();

    // 목록에서도 접수와 **다른 열**이어야 한다. 토픽 필터 화면은 broadcast 를 걸러내 표가 없으므로 전체 목록에서 본다.
    await page.goto(`/projects/${p.pid}/logs`);
    await expect(page.getByRole("columnheader", { name: "단말 수신" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "성공/대상" })).toBeVisible();
  });

  test("발송 화면: 로케일 문구는 변형과 함께 쓸 수 없고, 대조군은 개별 발송에서 사라진다", async ({ page }) => {
    const p = await seed(page, "send-ui");

    await page.goto(`/projects/${p.pid}/send/broadcast`);
    await page.getByRole("button", { name: "알림 옵션" }).click();
    await expect(page.getByLabel("홀드아웃(대조군) %")).toBeVisible();
    await page.getByLabel("홀드아웃(대조군) %").fill("10");
    await expect(page.getByText(/10% 에게는 아무것도 보내지 않고/)).toBeVisible();
    await page.getByLabel("방해금지 시간대 무시").check();
    await expect(page.getByText("이 발송은 프로젝트 방해금지 시간대를 건너뛰고 바로 나갑니다.")).toBeVisible();

    // 로케일 줄의 첫 칸은 default 로 채워진다 — 기본 문구 없이 보내면 빈 알림이 간다
    await page.getByRole("button", { name: "언어 추가" }).click();
    await expect(page.getByLabel("언어 태그")).toHaveValue("default");

    // 변형과 로케일은 두 축을 곱해 버려 어느 쪽의 폴백인지 알 수 없다 — 서버도 422 다
    await page.getByRole("button", { name: "변형 B 추가" }).click();
    await expect(page.getByText(/A\/B 변형과 함께 쓸 수 없습니다/)).toBeVisible();

    // 개별 발송은 받는 사람이 한 명이라 대조군이 성립하지 않는다
    await page.goto(`/projects/${p.pid}/send/single`);
    await page.getByRole("button", { name: "알림 옵션" }).click();
    await expect(page.getByLabel("홀드아웃(대조군) %")).toHaveCount(0);
  });
});

test.describe("라운드 6: 수신 보고 · 가져오기 되돌리기 · 저니 스텝 퍼널", () => {
  const sdk = (p: { apiKey: string; apiSecret: string }) => ({ "api-key": p.apiKey, "api-secret": p.apiSecret });

  async function seed(page: Page, prefix: string) {
    await ensureLogin(page);
    const created = await page.request.post("/api/admin/projects", {
      data: { name: `${prefix}-${Date.now()}` },
      headers: { origin: ORIGIN },
    });
    expect(created.status()).toBe(201);
    const j = (await created.json()).data;
    return { pid: j.project.id as string, apiKey: j.project.apiKey as string, apiSecret: j.api_secret as string };
  }

  test("수신 보고: 재보고는 한 번만 세고, 보고 전 도달 칸은 0 이 아니라 '—' 다", async ({ page }) => {
    const p = await seed(page, "receipt-ui");
    const token = `r6-recv-${Date.now()}`;
    const dev = await page.request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android" },
    });
    expect(dev.ok()).toBeTruthy();

    const sent = await page.request.post("/api/v1/messages", {
      headers: sdk(p),
      data: { type: "broadcast", title: "도달 확인", body: "본문" },
    });
    expect(sent.status()).toBe(202);
    const id = (await sent.json()).data.message.id as string;
    await page.request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: { origin: ORIGIN }, data: {} });

    // 아직 아무도 보고하지 않았다 — 0 을 찍으면 "아무에게도 안 닿았다" 로 읽힌다
    await page.goto(`/projects/${p.pid}/logs/${id}`);
    await expect(page.getByTitle(/아직 수신 보고가 없습니다/)).toBeVisible();

    // SDK 가 보고한다. 같은 (발송, 기기) 는 두 번째부터 recorded:false — 도달이 부풀지 않는다.
    const first = await page.request.post("/api/v1/messages/received", {
      headers: { "api-key": p.apiKey },
      data: { log_id: id, token },
    });
    expect(first.status()).toBe(202);
    expect((await first.json()).data.recorded).toBe(true);
    const again = await page.request.post("/api/v1/messages/received", {
      headers: { "api-key": p.apiKey },
      data: { log_id: id, token },
    });
    expect((await again.json()).data.recorded).toBe(false);

    await page.reload();
    // 보고가 한 건이라도 있으면 "—" 가 사라지고 수가 선다. 괄호 안 비율은 접수 수가
    // 분모라 Firebase 자격이 없는 프로젝트에서는 "—" 로 남는다(0% 가 아니다).
    await expect(page.getByTitle(/아직 수신 보고가 없습니다/)).toHaveCount(0);
    await expect(page.getByText(/^1 \(/)).toBeVisible();
  });

  test("억제 가져오기: 콘솔에서 배치를 되돌리고 감사 로그에 남는다", async ({ page }) => {
    const p = await seed(page, "revert-ui");
    const stamp = Date.now();
    const csv = `user_id\nrv-a-${stamp}\nrv-b-${stamp}\nrv-c-${stamp}\n`;
    const imported = await page.request.post(`/api/admin/projects/${p.pid}/audience/suppressions/import`, {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: { csv, reason: "manual" },
    });
    expect(imported.ok()).toBeTruthy();
    expect((await imported.json()).data.added).toBe(3);

    await page.goto(`/projects/${p.pid}/suppressions`);
    await expect(page.getByRole("heading", { name: "최근 가져오기" })).toBeVisible();
    await expect(page.getByText("3건 추가 · 0건 건너뜀")).toBeVisible();
    await expect(page.getByText(`rv-a-${stamp}`)).toBeVisible();

    // 수천 명의 억제가 한 번에 풀린다 — 네이티브 confirm() 이 아니라 콘솔 다이얼로그 뒤에 둔다
    await page.getByRole("button", { name: "되돌리기" }).click();
    const dialog = page.getByRole("dialog", { name: "가져오기 되돌리기" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/원래부터 수신 거부였던 사람은 그대로 둡니다/)).toBeVisible();
    await dialog.getByRole("button", { name: "되돌리기" }).click();

    await expect(page.getByText("3건을 되돌렸습니다.")).toBeVisible();
    // 되돌린 배치도 목록에 남는다 — 사라지면 같은 CSV 를 다시 올린다
    await expect(page.getByText("되돌림")).toBeVisible();
    await expect(page.getByText(`rv-a-${stamp}`)).toHaveCount(0);

    // 두 번 되돌릴 수 없다(409) — 그사이 다시 억제된 사람을 지우지 않는다
    const batches = await page.request.get(`/api/admin/projects/${p.pid}/audience/suppressions/import`, {
      headers: { origin: ORIGIN },
    });
    const batchId = (await batches.json()).data.batches[0].batch_id as string;
    const twice = await page.request.post(`/api/admin/projects/${p.pid}/audience/suppressions/import/revert`, {
      headers: { origin: ORIGIN, "content-type": "application/json" },
      data: { batch_id: batchId },
    });
    expect(twice.status()).toBe(409);

    // 되돌리기는 감사 로그에 남는다 — 누가 수천 건을 풀었는지 남지 않으면 사고를 되짚을 수 없다
    const audit = await page.request.get(`/api/admin/projects/${p.pid}/audit`, { headers: { origin: ORIGIN } });
    const actions = (await audit.json()).data.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain("suppression.import.revert");
  });

  test("저니 스텝: 발송이 스텝에 귀속되어 대기·발송·클릭률이 한 줄로 보인다", async ({ page }) => {
    const p = await seed(page, "funnel-ui");
    const stamp = Date.now();
    const ext = `jf-${stamp}`;
    const token = `jf-tok-${stamp}`;
    const h = idHash(ext, p.apiSecret);
    const dev = await page.request.post("/api/v1/devices", {
      headers: { "api-key": p.apiKey },
      data: { token, platform: "android", user_id: ext, identity_hash: h },
    });
    expect(dev.ok()).toBeTruthy();

    const created = await page.request.post(`/api/admin/projects/${p.pid}/journeys`, {
      headers: { origin: ORIGIN },
      data: {
        name: `funnel-${stamp}`,
        steps: [
          { type: "send", title: "1단계", body: "환영합니다" },
          { type: "wait", hours: 24 },
          { type: "send", title: "2단계", body: "아직 계신가요" },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    const journeyId = (await created.json()).data.journey.id as string;

    const enrolled = await page.request.post("/api/v1/journeys/enroll", {
      headers: { "api-key": p.apiKey },
      data: { journey: `funnel-${stamp}`, external_id: ext, identity_hash: h },
    });
    expect(enrolled.ok()).toBeTruthy();

    // 저니가 첫 스텝을 보낸다 → push_logs 에 journey_id·step_path 가 붙는다
    await page.request.post(`/api/admin/projects/${p.pid}/journeys/process`, { headers: { origin: ORIGIN }, data: {} });
    await page.request.post(`/api/admin/projects/${p.pid}/process-queue`, { headers: { origin: ORIGIN }, data: {} });

    const detail = await page.request.get(`/api/admin/projects/${p.pid}/journeys/${journeyId}`, {
      headers: { origin: ORIGIN },
    });
    const funnel = (await detail.json()).data.stepFunnel as { path: string; waiting: number; sent: number }[];
    // 줄은 스텝마다 하나 — 발송이 없던 스텝이 빠지면 화면에서 그 자리가 사라진다
    expect(funnel.map((r) => r.path)).toEqual(["0", "1", "2"]);
    expect(funnel[0].sent).toBeGreaterThan(0);
    // 1단계는 지나갔고(머문 사람 0) 지금은 대기 스텝에 서 있다
    expect(funnel[0].waiting).toBe(0);
    expect(funnel[1].waiting).toBe(1);
    expect(funnel[2].sent).toBe(0);

    await page.goto(`/projects/${p.pid}/journeys/${journeyId}`);
    await expect(page.getByText(/대기 0 · 발송 1 · 클릭 0%/)).toBeVisible();
    // 발송이 없던 스텝의 클릭률은 0% 가 아니라 "—" 다
    await expect(page.getByText(/대기 1 · 발송 0 · 클릭 —/)).toBeVisible();
  });
});
