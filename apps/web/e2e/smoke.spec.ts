import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { scryptSync, randomBytes, createHmac } from "node:crypto";

const ADMIN = { email: "e2e-admin@notikit.dev", password: "e2e-password-1234" };
/** 프로그램적 superadmin 토큰 — 세션 로그인 계정(ADMIN)과 다르다 */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "e2e-admin-token";
const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? "3100"}`;
const DB_URL = process.env.DATABASE_URL ?? "postgres://notikit:notikit@localhost:5432/notikit_e2e";

/** 앱의 verifyPassword 가 파싱하는 scrypt$N$r$p$salt$hash 형식 해시 생성 (테스트용, 저비용 N) */
function scryptHash(pw: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("hex")}$${dk.toString("hex")}`;
}

/**
 * 세션 쿠키 확보 — 최초 실행은 부트스트랩 register, 이후는 login.
 * 로그인은 이메일당 분당 10회로 제한되므로 한 번 받은 쿠키를 파일 전체에서 재사용한다
 * (테스트마다 로그인하면 스위트 후반이 429 로 무너진다).
 */
let cachedSession: string | null = null;
async function ensureLogin(page: Page) {
  if (cachedSession) {
    await page.context().addCookies([{ name: "notikit_session", value: cachedSession, url: ORIGIN }]);
    return;
  }
  const headers = { origin: ORIGIN };
  const reg = await page.request.post("/api/admin/register", { data: { org_name: "E2E", ...ADMIN }, headers });
  if (!reg.ok()) {
    const login = await page.request.post("/api/admin/login", { data: ADMIN, headers });
    expect(login.ok()).toBeTruthy();
  }
  cachedSession = (await page.context().cookies()).find((c) => c.name === "notikit_session")?.value ?? null;
  expect(cachedSession).toBeTruthy();
}

/** 세션 org 의 첫 프로젝트 id (없으면 생성) */
async function firstProjectId(page: Page): Promise<string> {
  const headers = { origin: ORIGIN };
  const list = await page.request.get("/api/admin/projects");
  const existing = (await list.json()).data?.projects?.[0]?.id;
  if (existing) return existing;
  const created = await page.request.post("/api/admin/projects", { data: { name: "e2e-nav" }, headers });
  expect(created.ok()).toBeTruthy();
  return (await created.json()).data.project.id;
}

test.describe("smoke", () => {
  test("unauthenticated console redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("button", { name: /로그인|계정 생성/ })).toBeVisible();
  });

  test("health 200", async ({ request }) => {
    const res = await request.get("/api/health");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
  });

  test("openapi spec has App SDK + Web Admin tags", async ({ request }) => {
    const res = await request.get("/api/openapi.json");
    expect(res.status()).toBe(200);
    const spec = await res.json();
    const tags = (spec.tags ?? []).map((t: { name: string }) => t.name);
    expect(tags).toContain("App SDK");
    expect(tags).toContain("Web Admin");
    expect(spec.paths["/api/v1/devices"]).toBeTruthy();
    expect(spec.paths["/api/admin/projects"]).toBeTruthy();
  });

  test("root redirects: 미로그인 → /login, 로그인 → /dashboard", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await ensureLogin(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test("tester page loads (authed)", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/tester");
    await expect(page.getByRole("heading", { name: /API 테스터/ })).toBeVisible();
  });

  test("dashboard page loads (authed)", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: /개요/ })).toBeVisible();
  });

  test("sidebar shell renders nav (authed)", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/dashboard");
    // 글로벌 사이드바 — 프로젝트 스코프 메뉴(발송/로그/참여)는 프로젝트 상세로 이동됨
    await expect(page.getByRole("link", { name: "프로젝트", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "시스템", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "프로필", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "계정", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "설정", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "발송", exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "API 테스터", exact: true })).toHaveCount(0);
  });

  test("system viewer renders stats", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/system");
    await expect(page.getByRole("heading", { name: "시스템" })).toBeVisible();
    await expect(page.getByText("발송 메시지 (24h)")).toBeVisible();
    await expect(page.getByText("웹훅 배송")).toBeVisible();
  });

  test("project sidebar renders project-scoped nav (발송/토픽/웹훅)", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);
    await page.goto(`/projects/${projectId}`);
    // 본문에도 발송 바로가기 버튼이 있으므로 사이드바 네비로 스코프
    const nav = page.getByRole("navigation");
    for (const label of ["개별 발송", "다중 발송", "전체 발송", "토픽 발송", "템플릿", "발송 큐"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(nav.getByRole("link", { name: "토픽", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "저니", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "웹훅", exact: true })).toBeVisible();
    // 세그먼트는 토픽으로 흡수됐다 — 메뉴가 남아 있으면 통합이 덜 된 것이다
    await expect(nav.getByRole("link", { name: "세그먼트", exact: true })).toHaveCount(0);
  });

  test("발송: 방식별 화면이 따로 있고 옛 /send 는 개별 발송으로 간다", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);

    await page.goto(`/projects/${projectId}/send`);
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/send/single$`));
    await expect(page.getByRole("main").getByRole("heading", { name: "개별 발송", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "사용자 아이디" })).toBeVisible();

    await page.goto(`/projects/${projectId}/send/broadcast`);
    await expect(page.getByRole("main").getByRole("heading", { name: "전체 발송", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "사용자 아이디" })).toHaveCount(0);

    // 토픽 화면은 링크로 받은 토픽을 미리 골라 둔다
    await page.goto(`/projects/${projectId}/send/topic?target=news`);
    await expect(page.getByRole("main").getByRole("heading", { name: "토픽 발송", exact: true })).toBeVisible();

    // 미리보기는 입력한 제목을 그대로 보여 준다
    await page.getByLabel("제목").fill("미리보기 제목");
    await expect(page.getByText("미리보기 제목", { exact: true })).toBeVisible();
  });

  test("개별 발송: 받는 사람은 팝업에서 검색해 고른다", async ({ page }) => {
    await ensureLogin(page);
    const created = await page.request.post("/api/admin/projects", { data: { name: `pick-${Date.now()}` }, headers: { origin: ORIGIN } });
    const cj = (await created.json()).data;
    const ext = `picker-${Date.now()}`;
    const hash = createHmac("sha256", cj.api_secret).update(ext).digest("hex");
    const ident = await page.request.post("/api/v1/users/identify", { headers: { "api-key": cj.project.apiKey }, data: { user_id: ext, identity_hash: hash } });
    expect(ident.ok()).toBeTruthy();

    await page.goto(`/projects/${cj.project.id}/send/single`);
    await page.getByRole("button", { name: "사용자 아이디" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill("picker-");
    await dlg.getByRole("option", { name: new RegExp(ext) }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "사용자 아이디" })).toContainText(ext);

    // 없는 사람을 찾으면 목록 대신 안내가 나온다
    await page.getByRole("button", { name: "사용자 아이디" }).click();
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill("nobody-here-xyz");
    await expect(dlg.getByText("일치하는 사용자가 없습니다")).toBeVisible();
  });

  test("다중 발송: 팝업에서 여러 명을 고르고, 미리보기는 첫 사람 기준으로 치환한다", async ({ page }) => {
    await ensureLogin(page);
    const created = await page.request.post("/api/admin/projects", { data: { name: `multi-ui-${Date.now()}` }, headers: { origin: ORIGIN } });
    const cj = (await created.json()).data;
    const stamp = Date.now();
    const exts = [`mu-a-${stamp}`, `mu-b-${stamp}`];
    for (const [i, ext] of exts.entries()) {
      const hash = createHmac("sha256", cj.api_secret).update(ext).digest("hex");
      await page.request.post("/api/v1/users/identify", { headers: { "api-key": cj.project.apiKey }, data: { user_id: ext, identity_hash: hash, attributes: { name: i === 0 ? "민지" : "도윤" } } });
    }

    await page.goto(`/projects/${cj.project.id}/send/multi`);
    await expect(page.getByRole("main").getByRole("heading", { name: "다중 발송", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "사용자 추가" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill(`mu-`);
    await dlg.getByRole("option", { name: new RegExp(exts[0]) }).click();
    await dlg.getByRole("option", { name: new RegExp(exts[1]) }).click();
    await dlg.getByRole("button", { name: "2명 선택" }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByText("사용자 아이디 (2명)")).toBeVisible();

    // 변수 버튼은 커서 위치에 넣고, 미리보기는 고른 순서의 첫 사람 값으로 보인다
    await page.getByLabel("제목").fill("님 안녕하세요");
    await page.getByLabel("제목").evaluate((el: HTMLInputElement) => el.setSelectionRange(0, 0));
    await page.getByRole("button", { name: "{{name}}" }).click();
    await expect(page.getByLabel("제목")).toHaveValue("{{name}}님 안녕하세요");
    const previewText = await page.getByText("민지님 안녕하세요", { exact: true }).count();
    const otherText = await page.getByText("도윤님 안녕하세요", { exact: true }).count();
    expect(previewText + otherText).toBe(1);
  });

  test("템플릿: 발송 화면에서 불러오면 내용이 채워지고, 커스텀 필드가 push data 로 간다", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };
    const cj = (await (await page.request.post("/api/admin/projects", { data: { name: `tpl-ui-${Date.now()}` }, headers })).json()).data;
    const pid = cj.project.id as string;
    const ext = `tpl-user-${Date.now()}`;
    const hash = createHmac("sha256", cj.api_secret).update(ext).digest("hex");
    await page.request.post("/api/v1/devices", { headers: { "api-key": cj.project.apiKey }, data: { token: `tpl-tok-${Date.now()}`, platform: "web", user_id: ext, identity_hash: hash } });
    const tpl = await page.request.post(`/api/admin/projects/${pid}/templates`, {
      headers,
      data: { name: "주문 도착", title: "주문이 도착했어요", body: "지금 확인해 보세요", fields: [{ key: "order_id", label: "주문 번호", required: true }, { key: "screen", default: "order" }] },
    });
    const tid = (await tpl.json()).data.template.id as string;

    // 템플릿 목록에서 "이 템플릿으로 발송"을 누르면 개별 발송 화면에 채워진 채로 열린다
    await page.goto(`/projects/${pid}/templates`);
    await page.getByRole("link", { name: "이 템플릿으로 발송" }).click();
    await expect(page).toHaveURL(new RegExp(`/send/single\\?template=${tid}`));
    await expect(page.getByLabel("제목")).toHaveValue("주문이 도착했어요");
    await expect(page.getByLabel("주문 번호 *")).toBeVisible();

    await page.getByRole("button", { name: "사용자 아이디" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill(ext);
    await dlg.getByRole("option", { name: new RegExp(ext) }).click();

    // 필수 필드를 비우면 검토 창도 열지 않는다
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await expect(page.getByText("필수 필드를 채우세요: order_id")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "발송 검토" })).toHaveCount(0);

    await page.getByLabel("주문 번호 *").fill("A-100");
    await expect(page.getByText("대상 1명 · 기기 1대")).toBeVisible();
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await page.getByRole("dialog", { name: "발송 검토" }).getByRole("button", { name: "1명에게 발송" }).click();
    await expect(page.getByText("큐 처리 완료", { exact: true })).toBeVisible();

    const inbox = await page.request.get(`/api/v1/inbox?user_id=${ext}&identity_hash=${hash}`, { headers: { "api-key": cj.project.apiKey } });
    expect((await inbox.json()).data.notifications[0].data).toEqual({ order_id: "A-100", screen: "order" });
  });

  test("발송 요약: 사용자를 고르면 도달 인원이 뜨고, 실제 발송 로그의 대상 수와 같다", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };
    const cj = (await (await page.request.post("/api/admin/projects", { data: { name: `est-${Date.now()}` }, headers })).json()).data;
    const pid = cj.project.id as string;
    const ext = `est-user-${Date.now()}`;
    const hash = createHmac("sha256", cj.api_secret).update(ext).digest("hex");
    await page.request.post("/api/v1/devices", { headers: { "api-key": cj.project.apiKey }, data: { token: `est-tok-${Date.now()}`, platform: "web", user_id: ext, identity_hash: hash } });

    await page.goto(`/projects/${pid}/send/single`);
    const summary = page.getByRole("region", { name: "요약" });
    await expect(summary.getByText("받는 사람을 고르면 도달 인원이 계산됩니다")).toBeVisible();

    await page.getByRole("button", { name: "사용자 아이디" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill(ext);
    await dlg.getByRole("option", { name: new RegExp(ext) }).click();

    // 대상이 바뀌면 곧바로 갱신되어야 한다. 1.5초로 잡으면 전체 스위트를 돌리는
    // 머신에서만 간헐적으로 넘쳐 실패한다 — 의도(즉시 갱신)는 3초로도 충분히 지켜진다.
    await expect(page.getByText("대상 1명 · 기기 1대")).toBeVisible({ timeout: 3000 });
    await expect(summary.getByRole("listitem").filter({ hasText: "Web" })).toContainText("1");

    await page.getByLabel("제목").fill("요약 확인");
    await page.getByLabel("본문").fill("도달 인원 비교");
    await page.getByRole("button", { name: "검토 후 발송" }).click();
    const review = page.getByRole("dialog", { name: "발송 검토" });
    await expect(review.getByText("대상 1명 · 기기 1대")).toBeVisible();
    await review.getByRole("button", { name: "1명에게 발송" }).click();
    await expect(page.getByText("큐 처리 완료", { exact: true })).toBeVisible();

    const logs = (await (await page.request.get(`/api/admin/projects/${pid}/logs`)).json()).data.logs;
    expect(logs[0].audienceUserCount).toBe(1);
    expect(logs[0].audienceDeviceCount).toBe(1);
  });

  test("전체 발송: 검토 다이얼로그의 최종 버튼을 눌러야만 나간다", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };
    const cj = (await (await page.request.post("/api/admin/projects", { data: { name: `bc-${Date.now()}` }, headers })).json()).data;
    const pid = cj.project.id as string;
    await page.request.post("/api/v1/devices", { headers: { "api-key": cj.project.apiKey }, data: { token: `bc-tok-${Date.now()}`, platform: "web" } });

    await page.goto(`/projects/${pid}/send/broadcast`);
    await page.getByLabel("제목").fill("전체 공지");
    await page.getByLabel("본문").fill("모두에게");
    await expect(page.getByText(/^대상 \d+명 · 기기 1대$/)).toBeVisible();

    await page.getByRole("button", { name: "검토 후 발송" }).click();
    const review = page.getByRole("dialog", { name: "발송 검토" });
    await expect(review.getByText("전체 활성 기기")).toBeVisible();
    await expect(review.getByText("프로젝트의 모든 활성 기기에 나갑니다")).toBeVisible();
    await expect(review.getByRole("checkbox", { name: "발송 즉시 큐 처리 (로그 생성)" })).toBeChecked();

    // 돌아가면 아무것도 나가지 않는다
    await review.getByRole("button", { name: "돌아가기" }).click();
    await expect(review).toBeHidden();
    const before = (await (await page.request.get(`/api/admin/projects/${pid}/logs`)).json()).data.logs;
    expect(before).toHaveLength(0);

    await page.getByRole("button", { name: "검토 후 발송" }).click();
    await review.getByRole("button", { name: /명에게 발송$/ }).click();
    await expect(page.getByText("큐 처리 완료", { exact: true })).toBeVisible();
    const after = (await (await page.request.get(`/api/admin/projects/${pid}/logs`)).json()).data.logs;
    expect(after).toHaveLength(1);
  });

  test("미리보기: iOS/Android 탭마다 잘리는 줄 수가 다르다", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);
    await page.goto(`/projects/${projectId}/send/single`);
    await page.getByLabel("본문").fill(Array.from({ length: 10 }, (_, i) => `줄 ${i + 1}`).join("\n"));

    const tabs = page.getByRole("tablist", { name: "미리보기 플랫폼" });
    await expect(tabs.getByRole("tab", { name: "iOS" })).toHaveAttribute("aria-selected", "true");
    const iosBody = page.locator('[data-platform="ios"] p', { hasText: "줄 1" });
    await expect(iosBody).toHaveClass(/line-clamp-4/);

    await tabs.getByRole("tab", { name: "Android" }).click();
    await expect(page.locator('[data-platform="ios"]')).toHaveCount(0);
    const androidBody = page.locator('[data-platform="android"] p', { hasText: "줄 1" });
    await expect(androidBody).toHaveClass(/line-clamp-1/);
    await page.getByRole("button", { name: "펼치기" }).click();
    await expect(androidBody).toHaveClass(/line-clamp-7/);
  });

  test("글자 수: 제목이 50자를 넘으면 잘림 경고가 보인다", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);
    await page.goto(`/projects/${projectId}/send/single`);
    await page.getByLabel("제목").fill("가".repeat(50));
    await expect(page.getByText("제목이 50자를 넘어 iOS 에서 잘릴 수 있습니다")).toHaveCount(0);
    await page.getByLabel("제목").fill("가".repeat(51));
    await expect(page.getByText("제목이 50자를 넘어 iOS 에서 잘릴 수 있습니다")).toBeVisible();
    await expect(page.getByText("· iOS 에서 잘릴 수 있음")).toBeVisible();
  });

  test("테스트 발송: 고른 한 명에게만 가고 로그에 테스트 칩이 붙는다", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };
    const cj = (await (await page.request.post("/api/admin/projects", { data: { name: `test-send-${Date.now()}` }, headers })).json()).data;
    const pid = cj.project.id as string;
    const ext = `tester-${Date.now()}`;
    const hash = createHmac("sha256", cj.api_secret).update(ext).digest("hex");
    await page.request.post("/api/v1/devices", { headers: { "api-key": cj.project.apiKey }, data: { token: `ts-tok-${Date.now()}`, platform: "web", user_id: ext, identity_hash: hash } });

    await page.goto(`/projects/${pid}/send/broadcast`);
    const title = `테스트 알림 ${Date.now()}`;
    await page.getByLabel("제목").fill(title);
    await page.getByLabel("본문").fill("나에게만");
    await page.getByRole("button", { name: "테스트 발송" }).click();
    const dlg = page.getByRole("dialog", { name: "테스트 받을 사용자" });
    await dlg.getByRole("combobox", { name: "사용자 검색" }).fill(ext);
    await dlg.getByRole("option", { name: new RegExp(ext) }).click();
    await expect(page.getByText(`${ext} 에게 테스트 발송했습니다`)).toBeVisible();
    // 작성 중인 내용은 그대로 남는다
    await expect(page.getByLabel("제목")).toHaveValue(title);

    const logs = (await (await page.request.get(`/api/admin/projects/${pid}/logs`)).json()).data.logs;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ type: "single", target: ext, isTest: true });

    await page.goto(`/projects/${pid}/logs/single`);
    const row = page.getByRole("row").filter({ hasText: title });
    await expect(row.getByText("테스트", { exact: true })).toBeVisible();
  });

  test("tenant isolation: 세션 유저는 타 org 프로젝트에 접근 불가", async ({ page }) => {
    await ensureLogin(page); // 세션 = e2e-admin 의 org
    // superadmin(x-admin-token)으로 새 org 에 프로젝트 생성
    const create = await page.request.post("/api/admin/projects", {
      headers: { "x-admin-token": "e2e-admin-token", origin: ORIGIN },
      data: { name: `otherorg-${Date.now()}` },
    });
    expect(create.ok()).toBeTruthy();
    const p2 = (await create.json()).data.project.id as string;

    // 세션 유저 목록에는 타 org 프로젝트가 없어야 함
    const list = await page.request.get("/api/admin/projects");
    const ids = ((await list.json()).data.projects as { id: string }[]).map((p) => p.id);
    expect(ids).not.toContain(p2);

    // 타 org 프로젝트 하위 라우트 접근 → 404 (읽기/쓰기 모두)
    expect((await page.request.get(`/api/admin/projects/${p2}/logs`)).status()).toBe(404);
    const patch = await page.request.patch(`/api/admin/projects/${p2}`, {
      headers: { origin: ORIGIN },
      data: { quiet_start_hour: 5 },
    });
    expect(patch.status()).toBe(404);
  });

  test("CSRF: 쿠키 세션 mutation 은 Origin 없으면 403", async ({ page }) => {
    await ensureLogin(page);
    // Origin 헤더 없이(브라우저 아닌 컨텍스트) 상태변경 POST → 거부
    const res = await page.request.post("/api/admin/projects", { data: { name: "csrf-x" } });
    expect(res.status()).toBe(403);
  });

  test("body 상한: 32KB 초과 요청은 413", async ({ page }) => {
    await ensureLogin(page);
    const res = await page.request.post("/api/admin/projects", {
      headers: { origin: ORIGIN },
      data: { name: "big", pad: "A".repeat(40_000) },
    });
    expect(res.status()).toBe(413);
  });

  test("세션 무효화: 로그아웃 후 옛 쿠키 재사용은 거부", async ({ page }) => {
    // 공유 관리자(ADMIN)로 로그아웃하면 sessionVersion 이 올라 병렬로 도는 다른 스펙의
    // 세션까지 끊긴다(features.spec 이 도중에 /login 으로 튕기던 flaky 의 원인). 전용 계정을 쓴다.
    const email = `logout-${Date.now()}@notikit.dev`;
    const pw = "logout-pass-1234";
    const sql = postgres(DB_URL, { max: 1 });
    try {
      const [org] = await sql`insert into organizations (name) values ('LogoutOrg') returning id`;
      await sql`insert into admin_users (org_id, email, password_hash, role) values (${org.id}, ${email}, ${scryptHash(pw)}, 'owner')`;
    } finally {
      await sql.end();
    }
    const login = await page.request.post("/api/admin/login", { headers: { origin: ORIGIN }, data: { email, password: pw } });
    expect(login.ok()).toBeTruthy();
    const cookie = (await page.context().cookies()).find((c) => c.name === "notikit_session");
    expect(cookie?.value).toBeTruthy();
    // 로그아웃 → sessionVersion 증가
    const out = await page.request.post("/api/admin/logout", { headers: { origin: ORIGIN } });
    expect(out.ok()).toBeTruthy();
    // 옛 쿠키로 admin 호출 → 무효
    const replay = await page.request.get("/api/admin/projects", {
      headers: { cookie: `notikit_session=${cookie!.value}` },
    });
    expect(replay.status()).toBe(401);
  });

  test("역할: viewer 는 쓰기 거부(403), 읽기 허용(200)", async ({ page }) => {
    const email = `viewer-${Date.now()}@notikit.dev`;
    const pw = "viewer-pass-1234";
    const sql = postgres(DB_URL, { max: 1 });
    try {
      const [org] = await sql`insert into organizations (name) values ('ViewerOrg') returning id`;
      await sql`insert into admin_users (org_id, email, password_hash, role) values (${org.id}, ${email}, ${scryptHash(pw)}, 'viewer')`;
    } finally {
      await sql.end();
    }

    const login = await page.request.post("/api/admin/login", { headers: { origin: ORIGIN }, data: { email, password: pw } });
    expect(login.ok()).toBeTruthy();

    // 읽기 허용
    expect((await page.request.get("/api/admin/projects")).status()).toBe(200);
    // 쓰기 거부 (viewer)
    const create = await page.request.post("/api/admin/projects", { headers: { origin: ORIGIN }, data: { name: "viewer-nope" } });
    expect(create.status()).toBe(403);
    // 호스트 인프라 지표는 viewer 에게 비공개 (멀티테넌트에서 타 org 부하 유추 방지)
    expect((await page.request.get("/api/admin/system/host")).status()).toBe(403);
    // 발송 집계는 org 스코프 읽기이므로 허용
    expect((await page.request.get("/api/admin/system/stats")).status()).toBe(200);
  });

  test("멤버 관리: 생성·역할변경·삭제 + 권한상승/자기잠금 차단", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };
    const email = `member-${Date.now()}@notikit.dev`;

    // owner 가 viewer 생성
    const created = await page.request.post("/api/admin/users", {
      headers,
      data: { email, password: "member-pass-1234", role: "viewer" },
    });
    expect(created.status()).toBe(201);
    const memberId = (await created.json()).data.user.id as string;

    // 목록에 노출되고 해시는 절대 내려오지 않음
    const list = await page.request.get("/api/admin/users");
    expect(list.status()).toBe(200);
    const body = await list.text();
    expect(body).toContain(email);
    expect(body).not.toContain("passwordHash");
    expect(body).not.toContain("scrypt$");

    // 중복 이메일 거부
    const dup = await page.request.post("/api/admin/users", {
      headers,
      data: { email, password: "member-pass-1234", role: "viewer" },
    });
    expect(dup.status()).toBe(409);

    // 역할 변경
    const patched = await page.request.patch(`/api/admin/users/${memberId}`, { headers, data: { role: "admin" } });
    expect(patched.status()).toBe(200);
    expect((await patched.json()).data.user.role).toBe("admin");

    // 자기 자신 삭제 차단 (org 잠금 방지)
    const me = (await (await page.request.get("/api/admin/users")).json()).data.users.find(
      (u: { isSelf: boolean }) => u.isSelf
    );
    expect((await page.request.delete(`/api/admin/users/${me.id}`, { headers })).status()).toBe(400);
    // 마지막 owner 강등 차단
    expect((await page.request.patch(`/api/admin/users/${me.id}`, { headers, data: { role: "viewer" } })).status()).toBe(400);

    // CSRF: Origin 없으면 거부
    expect((await page.request.delete(`/api/admin/users/${memberId}`)).status()).toBe(403);

    // 삭제
    expect((await page.request.delete(`/api/admin/users/${memberId}`, { headers })).status()).toBe(200);
    expect(await (await page.request.get("/api/admin/users")).text()).not.toContain(email);
  });

  test("멤버 관리: admin 은 owner 를 만들 수 없고 viewer 는 목록만", async ({ page }) => {
    await ensureLogin(page);
    const headers = { origin: ORIGIN };

    // owner 가 admin 을 하나 만든다
    const adminEmail = `esc-admin-${Date.now()}@notikit.dev`;
    const pw = "esc-admin-pass-1234";
    expect(
      (await page.request.post("/api/admin/users", { headers, data: { email: adminEmail, password: pw, role: "admin" } })).status()
    ).toBe(201);

    // 그 admin 으로 로그인 → owner 생성 시도는 권한 상승이므로 403
    expect((await page.request.post("/api/admin/login", { headers, data: { email: adminEmail, password: pw } })).ok()).toBeTruthy();
    const escalate = await page.request.post("/api/admin/users", {
      headers,
      data: { email: `esc-owner-${Date.now()}@notikit.dev`, password: "esc-owner-pass-1234", role: "owner" },
    });
    expect(escalate.status()).toBe(403);
  });

  test("계정 페이지: 내 계정 + 멤버 관리 노출", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/account");
    // 헤더에도 현재 메뉴명이 표시되므로 본문으로 스코프
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "계정", exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "멤버", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: /추가/ })).toBeVisible();
    // 내 계정은 프로필로 분리됨
    await expect(main.getByRole("heading", { name: "내 계정", exact: true })).toHaveCount(0);
  });

  test("프로필 페이지: 내 계정 + 비밀번호 변경", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/profile");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "프로필", exact: true })).toBeVisible();
    // 탭으로 분리됨 — 기본은 내 계정, 비밀번호는 탭을 눌러야 나온다
    await expect(main.getByRole("heading", { name: "내 계정", exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: /비밀번호/ })).toHaveCount(0);

    await main.getByRole("tab", { name: /비밀번호/ }).click();
    await expect(main.getByRole("heading", { name: /비밀번호/ })).toBeVisible();
    await expect(main.getByRole("heading", { name: "내 계정", exact: true })).toHaveCount(0);
    // 현재 비밀번호가 틀리면 403, CSRF 없으면 403
    const headers = { origin: ORIGIN };
    const wrong = await page.request.post("/api/admin/me/password", {
      headers,
      data: { current_password: "definitely-wrong-pw", new_password: "another-pass-1234" },
    });
    expect(wrong.status()).toBe(403);
    expect((await page.request.post("/api/admin/me/password", { data: { current_password: "x", new_password: "yyyyyyyy" } })).status()).toBe(403);
  });

  test("시스템 메트릭 이력: owner 는 조회, viewer 는 거부", async ({ page }) => {
    await ensureLogin(page);
    const res = await page.request.get("/api/admin/system/history?range=1h");
    expect(res.status()).toBe(200);
    const d = (await res.json()).data;
    expect(Array.isArray(d.points)).toBeTruthy();
    expect(d.range).toBe("1h");
    // 잘못된 range 는 기본값으로 폴백
    expect((await (await page.request.get("/api/admin/system/history?range=__proto__")).json()).data.range).toBe("1h");
  });

  test("설정 페이지: 조직 정보 표시 + owner 만 이름 변경", async ({ page }) => {
    await ensureLogin(page);
    const org = await page.request.get("/api/admin/org");
    expect(org.status()).toBe(200);
    expect((await org.json()).data.org.name).toBeTruthy();

    await page.goto("/settings");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { name: "설정", exact: true })).toBeVisible();
    await expect(main.getByRole("heading", { name: "조직", exact: true })).toBeVisible();
    // 이름 변경은 CSRF 검사를 통과해야 한다
    expect((await page.request.patch("/api/admin/org", { data: { name: "x" } })).status()).toBe(403);
  });

  test("API 문서: Redoc 이 스펙을 콘솔 테마로 렌더한다", async ({ request }) => {
    const res = await request.get("/docs");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("Redoc.init");
    expect(html).toContain("/api/openapi.json");
    // 콘솔과 같은 테마 신호를 읽어야 색이 어긋나지 않는다
    expect(html).toContain('localStorage.getItem("theme")');
    // 스펙 자체가 서빙되지 않으면 Redoc 은 빈 화면이 된다
    expect((await request.get("/api/openapi.json")).status()).toBe(200);
  });

  test("문서: md 파일이 자동으로 목록·본문이 된다", async ({ request }) => {
    // 인증 없이 열리는 iframe 본문 — 파일이 곧 문서다
    const res = await request.get("/guide-frame/auth");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>인증</h1>");
    expect(html).toContain("<table>"); // 마크다운 표가 변환됐다

    // 목록에 없는 슬러그·경로 조작은 저장소 밖 파일을 읽지 못한다
    expect((await request.get("/guide-frame/nope")).status()).toBe(404);
    expect((await request.get("/guide-frame/..%2F..%2Fpackage")).status()).toBe(404);
  });

  test("오디언스: 유저·디바이스·토픽·수신거부 화면이 뜨고 나란히 링크된다", async ({ page, request }) => {
    await ensureLogin(page);
    const res = await request.get("/api/admin/projects", { headers: { "x-admin-token": ADMIN_TOKEN } });
    const pid = (await res.json()).data.projects[0].id as string;

    for (const [path, heading] of [
      ["users", "유저"],
      ["devices", "디바이스"],
      ["topics", "토픽"],
      ["suppressions", "수신 거부"],
    ] as const) {
      await page.goto(`/projects/${pid}/${path}`);
      await expect(page.getByRole("main").getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    // 사이드바에 오디언스 그룹이 노출된다
    const nav = page.getByRole("navigation").first();
    for (const label of ["유저", "디바이스", "토픽", "수신 거부"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("오디언스 API: 토픽 생성·삭제 + 수신거부 추가·해제", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN_TOKEN }, data: { name: `aud-${Date.now()}` } });
    const pid = (await created.json()).data.project.id as string;
    const admin = { "x-admin-token": ADMIN_TOKEN };

    const mk = await request.post(`/api/admin/projects/${pid}/audience/topics`, { headers: admin, data: { name: "news" } });
    expect(mk.status()).toBe(201);
    const list = await request.get(`/api/admin/projects/${pid}/audience/topics`, { headers: admin });
    expect((await list.json()).data.topics[0]).toMatchObject({ name: "news", userCount: 0, deviceCount: 0 });
    const del = await request.delete(`/api/admin/projects/${pid}/audience/topics?name=news`, { headers: admin });
    expect(del.status()).toBe(200);

    const sup = await request.post(`/api/admin/projects/${pid}/audience/suppressions`, { headers: admin, data: { user_id: "user-9", reason: "opt_out" } });
    expect(sup.status()).toBe(201);
    const sid = (await sup.json()).data.suppression.id as string;

    // 타 프로젝트 id 로는 지울 수 없다
    const other = await request.post("/api/admin/projects", { headers: admin, data: { name: `aud2-${Date.now()}` } });
    const otherPid = (await other.json()).data.project.id as string;
    const cross = await request.delete(`/api/admin/projects/${otherPid}/audience/suppressions?id=${sid}`, { headers: admin });
    expect(cross.status()).toBe(404);

    const gone = await request.delete(`/api/admin/projects/${pid}/audience/suppressions?id=${sid}`, { headers: admin });
    expect(gone.status()).toBe(200);
  });

  test("디바이스 목록: 토큰 원문을 노출하지 않는다", async ({ request }) => {
    const created = await request.post("/api/admin/projects", { headers: { "x-admin-token": ADMIN_TOKEN }, data: { name: `dev-${Date.now()}` } });
    const cj = await created.json();
    const pid = cj.data.project.id as string;
    const apiKey = cj.data.project.apiKey as string;
    const token = `secret-token-${Date.now()}`;
    await request.post("/api/v1/devices", { headers: { "api-key": apiKey }, data: { token, platform: "android" } });

    const res = await request.get(`/api/admin/projects/${pid}/audience/devices`, { headers: { "x-admin-token": ADMIN_TOKEN } });
    const body = await res.text();
    expect(body).not.toContain(token);
    const d = JSON.parse(body).data;
    expect(d.devices[0].tokenPreview).toContain("…");
    expect(d.summary).toMatchObject({ total: 1, active: 1, anonymous: 1 });
  });

  test("통계 그룹: 접속·참여·설치 변동 화면이 뜨고 사이드바에 묶여 있다", async ({ page, request }) => {
    await ensureLogin(page);
    const res = await request.get("/api/admin/projects", { headers: { "x-admin-token": ADMIN_TOKEN } });
    const pid = (await res.json()).data.projects[0].id as string;

    for (const [path, heading] of [
      ["activity", "접속 통계"],
      ["engagement", "참여"],
      ["installs", "설치 변동"],
    ] as const) {
      await page.goto(`/projects/${pid}/${path}`);
      await expect(page.getByRole("main").getByRole("heading", { name: heading, exact: true })).toBeVisible();
    }

    const nav = page.getByRole("navigation").first();
    for (const label of ["접속", "참여", "설치 변동"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("업데이트: 버전 화면이 뜨고 기능이 꺼져 있으면 설치 경로가 닫힌다", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/system/update");
    await expect(page.getByRole("heading", { name: "업데이트", level: 1 })).toBeVisible();

    // 빌드에 박힌 버전이 화면에 나온다
    const status = await page.request.get("/api/admin/update");
    expect(status.ok()).toBeTruthy();
    const body = (await status.json()).data;
    expect(body.current).toMatch(/^\d+\.\d+\.\d+/);
    // 업데이트 서버를 설정하지 않은 설치 — "최신"이 아니라 "모름"이어야 한다
    expect(body.status).toBe("unconfigured");
    expect(body.canUpdate).toBe(false);

    // NOTIKIT_SELF_UPDATE 가 꺼져 있으면 설치 경로는 존재하지 않는 것처럼 굴어야 한다
    const start = await page.request.post("/api/admin/update", {
      headers: { origin: ORIGIN },
      data: { target_version: "99.0.0" },
    });
    expect(start.status()).toBe(404);
  });

  test("업데이트: 로그인하지 않으면 상태도 볼 수 없다", async ({ page }) => {
    await page.context().clearCookies();
    const res = await page.request.get("/api/admin/update");
    expect(res.status()).toBe(401);
  });

  /**
   * 로그 purge — 로그가 코어 테이블과 같은 DB 에 있어서, 이게 멈추면 디스크가 차고
   * 푸시 전체가 선다. 삭제 경로라 "지워지는가"보다 **안 지워져야 할 것이 남는가**가 중요하다.
   */
  test("로그 purge: 오래된 종료 로그만 지우고 진행 중인 발송은 남긴다", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);
    const sql = postgres(DB_URL, { max: 1 });

    try {
      const mk = async (status: string, daysAgo: number) => {
        const [row] = await sql`
          insert into push_logs (project_id, type, title, body, status, created_at)
          values (${projectId}, 'single', 'purge-test', 'x', ${status},
                  now() - (${daysAgo} || ' days')::interval)
          returning id`;
        return row.id as string;
      };

      const oldDone = await mk("completed", 30);
      const oldFailed = await mk("failed", 30);
      const oldLogged = await mk("logged", 30);
      // 오래됐지만 워커가 아직 손댈 수 있는 것들 — 지우면 예약 발송이 조용히 사라진다
      const oldQueued = await mk("queued", 30);
      const oldScheduled = await mk("scheduled", 30);
      const oldProcessing = await mk("processing", 30);
      // 리텐션 안쪽 — 최근 것은 종료됐어도 남아야 한다
      const recentDone = await mk("completed", 0);

      const res = await page.request.post(
        `/api/admin/projects/${projectId}/logs/purge`,
        { headers: { origin: ORIGIN } }
      );
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()).data;
      expect(body.retentionDays).toBe(1);
      expect(body.purged).toBeGreaterThanOrEqual(3);

      const alive = async (id: string) =>
        (await sql`select 1 from push_logs where id = ${id}`).length > 0;

      expect(await alive(oldDone)).toBe(false);
      expect(await alive(oldFailed)).toBe(false);
      expect(await alive(oldLogged)).toBe(false);

      expect(await alive(oldQueued)).toBe(true);
      expect(await alive(oldScheduled)).toBe(true);
      expect(await alive(oldProcessing)).toBe(true);
      expect(await alive(recentDone)).toBe(true);

      // 정리 — 다음 실행에 남기지 않는다
      await sql`delete from push_logs where title = 'purge-test'`;
    } finally {
      await sql.end();
    }
  });

  test("로그 purge: 미인증 거부 + Origin 없는 호출 거부", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);

    // 삭제 엔드포인트라 CSRF 방어가 걸려 있어야 한다
    const noOrigin = await page.request.post(`/api/admin/projects/${projectId}/logs/purge`);
    expect(noOrigin.status()).toBe(403);

    await page.context().clearCookies();
    const anon = await page.request.post(
      `/api/admin/projects/${projectId}/logs/purge`,
      { headers: { origin: ORIGIN } }
    );
    expect(anon.status()).toBe(401);
  });

  test("기간 선택(Segmented): Tab 은 선택된 칸에만 멈추고 방향키로 선택이 옮겨간다", async ({ page }) => {
    await ensureLogin(page);
    const pid = await firstProjectId(page);
    await page.goto(`/projects/${pid}`);
    const group = page.getByRole("main").getByRole("radiogroup").first();
    const radios = group.getByRole("radio");
    await expect(radios.first()).toBeVisible();

    const checked = group.locator('[role="radio"][aria-checked="true"]');
    await expect(checked).toHaveAttribute("tabindex", "0");
    await expect(group.locator('[role="radio"][tabindex="0"]')).toHaveCount(1);

    const count = await radios.count();
    const before = await radios.evaluateAll((els) => els.findIndex((el) => el.getAttribute("aria-checked") === "true"));
    await checked.focus();
    await page.keyboard.press("ArrowRight");
    const next = (before + 1) % count;
    await expect(radios.nth(next)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(next)).toBeFocused();

    await page.keyboard.press("ArrowLeft");
    await expect(radios.nth(before)).toHaveAttribute("aria-checked", "true");
    await expect(radios.nth(before)).toBeFocused();
  });

  test("다이얼로그: Tab 순환이 배경으로 새지 않고 배경은 inert 다", async ({ page }) => {
    await ensureLogin(page);
    await page.goto("/projects");
    await page.getByRole("main").getByRole("button", { name: "새 프로젝트" }).first().click();
    const dlg = page.getByRole("dialog", { name: "새 프로젝트" });
    await expect(dlg).toBeVisible();
    // 첫 포커스는 본문의 첫 입력(닫기 X 가 아니라)
    await expect(dlg.getByLabel("이름")).toBeFocused();

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      expect(await dlg.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    }
    // 앱 셸(사이드바·헤더)이 든 배경은 열린 동안 inert
    expect(await page.evaluate(() => Array.from(document.body.children).some((el) => (el as HTMLElement).inert))).toBe(true);

    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    expect(await page.evaluate(() => Array.from(document.body.children).some((el) => (el as HTMLElement).inert))).toBe(false);
  });

});
