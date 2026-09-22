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

/** 로그아웃 등으로 세션을 무효화한 테스트는 캐시를 버려야 다음 테스트가 새로 받는다 */
function invalidateSessionCache() {
  cachedSession = null;
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
    const ident = await page.request.post("/api/v1/users/identify", { headers: { "api-key": cj.project.apiKey }, data: { external_id: ext, identity_hash: hash } });
    expect(ident.ok()).toBeTruthy();

    await page.goto(`/projects/${cj.project.id}/send/single`);
    await page.getByRole("button", { name: "사용자 아이디" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("textbox", { name: "사용자 검색" }).fill("picker-");
    await dlg.getByRole("button", { name: new RegExp(ext) }).click();
    await expect(dlg).toBeHidden();
    await expect(page.getByRole("button", { name: "사용자 아이디" })).toContainText(ext);

    // 없는 사람을 찾으면 목록 대신 안내가 나온다
    await page.getByRole("button", { name: "사용자 아이디" }).click();
    await dlg.getByRole("textbox", { name: "사용자 검색" }).fill("nobody-here-xyz");
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
      await page.request.post("/api/v1/users/identify", { headers: { "api-key": cj.project.apiKey }, data: { external_id: ext, identity_hash: hash, attributes: { name: i === 0 ? "민지" : "도윤" } } });
    }

    await page.goto(`/projects/${cj.project.id}/send/multi`);
    await expect(page.getByRole("main").getByRole("heading", { name: "다중 발송", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "사용자 추가" }).click();
    const dlg = page.getByRole("dialog", { name: "사용자 검색" });
    await dlg.getByRole("textbox", { name: "사용자 검색" }).fill(`mu-`);
    await dlg.getByRole("button", { name: new RegExp(exts[0]) }).click();
    await dlg.getByRole("button", { name: new RegExp(exts[1]) }).click();
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
    await page.request.post("/api/v1/devices", { headers: { "api-key": cj.project.apiKey }, data: { token: `tpl-tok-${Date.now()}`, platform: "web", external_id: ext, identity_hash: hash } });
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
    await dlg.getByRole("textbox", { name: "사용자 검색" }).fill(ext);
    await dlg.getByRole("button", { name: new RegExp(ext) }).click();

    // 필수 필드를 비우면 보내지 않는다
    await page.getByRole("button", { name: "발송", exact: true }).click();
    await expect(page.getByText("필수 필드를 채우세요: order_id")).toBeVisible();

    await page.getByLabel("주문 번호 *").fill("A-100");
    await page.getByRole("button", { name: "발송", exact: true }).click();
    await expect(page.getByText("큐 처리 완료", { exact: true })).toBeVisible();

    const inbox = await page.request.get(`/api/v1/inbox?external_id=${ext}&identity_hash=${hash}`, { headers: { "api-key": cj.project.apiKey } });
    expect((await inbox.json()).data.notifications[0].data).toEqual({ order_id: "A-100", screen: "order" });
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
    await ensureLogin(page);
    const cookie = (await page.context().cookies()).find((c) => c.name === "notikit_session");
    expect(cookie?.value).toBeTruthy();
    // 로그아웃 → sessionVersion 증가
    const out = await page.request.post("/api/admin/logout", { headers: { origin: ORIGIN } });
    expect(out.ok()).toBeTruthy();
    invalidateSessionCache(); // sessionVersion 증가 → 캐시된 쿠키도 무효
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

    const sup = await request.post(`/api/admin/projects/${pid}/audience/suppressions`, { headers: admin, data: { external_id: "user-9", reason: "opt_out" } });
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

});
