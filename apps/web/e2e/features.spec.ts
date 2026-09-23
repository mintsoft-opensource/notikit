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
