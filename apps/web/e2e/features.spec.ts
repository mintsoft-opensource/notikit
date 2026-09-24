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
    return;
  }
  const headers = { origin: ORIGIN };
  const reg = await page.request.post("/api/admin/register", { data: { org_name: "E2E", ...SESSION_ADMIN }, headers });
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
    expect((await first.json()).data).toEqual({ added: 2, skipped: 3 });

    const again = await request.post(url, { headers: admin, data: { rows: [{ user_id: "u1" }, { token: "tok-x" }] } });
    expect((await again.json()).data).toEqual({ added: 1, skipped: 1 });

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
    await expect(added.getByText("눌렀다면")).toBeVisible();
    await expect(added.getByText("안 눌렀다면")).toBeVisible();

    // 갈래 안에 발송을 넣고 제목을 비운 채 저장하면 그 칸 아래에 오류가 붙는다
    await added.getByRole("button", { name: "send 추가" }).first().click();
    await page.getByRole("button", { name: "저장" }).click();
    const inner = page.getByRole("group", { name: "스텝 1" }).last();
    const title = inner.getByLabel("제목");
    await expect(title).toHaveAttribute("aria-invalid", "true");
    await expect(title).toBeFocused();
    await expect(page.getByText("제목을 입력하세요")).toBeVisible();

    // 지우면 초점이 사라지지 않고 앞 행으로 돌아온다
    await added.getByRole("button", { name: "스텝 삭제" }).click();
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
    await expect(page.getByLabel("템플릿")).toHaveValue("");

    await page.getByLabel("템플릿").selectOption({ label: name });
    await page.getByRole("dialog").getByRole("button", { name: "적용" }).click();
    await expect(page.getByLabel("제목", { exact: true })).toHaveValue("템플릿 제목");
    // 고른 템플릿과 화면의 선택이 어긋나지 않는다
    await expect(page.getByLabel("템플릿")).not.toHaveValue("");
  });
});
