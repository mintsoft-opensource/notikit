import { test, expect, type Page } from "@playwright/test";
import postgres from "postgres";
import { scryptSync, randomBytes } from "node:crypto";

const ADMIN = { email: "e2e-admin@notikit.dev", password: "e2e-password-1234" };
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

  test("project sidebar renders project-scoped nav (발송/세그먼트/웹훅)", async ({ page }) => {
    await ensureLogin(page);
    const projectId = await firstProjectId(page);
    await page.goto(`/projects/${projectId}`);
    // 본문에도 발송 바로가기 버튼이 있으므로 사이드바 네비로 스코프
    const nav = page.getByRole("navigation");
    await expect(nav.getByRole("link", { name: "발송", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "세그먼트", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "저니", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "웹훅", exact: true })).toBeVisible();
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

  test("docs page loads (Scalar)", async ({ request }) => {
    const res = await request.get("/docs");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("api-reference");
  });
});
