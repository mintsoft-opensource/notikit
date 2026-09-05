import { test, expect, type Page } from "@playwright/test";

const ADMIN = { email: "e2e-admin@notikit.dev", password: "e2e-password-1234" };
const ORIGIN = `http://localhost:${process.env.E2E_PORT ?? "3100"}`;

/** 세션 쿠키 확보 — 최초 실행은 부트스트랩 register, 이후는 login (page 컨텍스트에 쿠키 저장) */
async function ensureLogin(page: Page) {
  const headers = { origin: ORIGIN };
  const reg = await page.request.post("/api/admin/register", { data: { org_name: "E2E", ...ADMIN }, headers });
  if (!reg.ok()) {
    const login = await page.request.post("/api/admin/login", { data: ADMIN, headers });
    expect(login.ok()).toBeTruthy();
  }
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

  test("landing page renders", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: /사용자·계정 레이어/ })).toBeVisible();
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
    // 사이드바 네비 항목(goji 스타일 앱 셸) — exact 로 사이드바 링크만 매칭
    await expect(page.getByRole("link", { name: "프로젝트", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "발송", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "설정", exact: true })).toBeVisible();
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

  test("docs page loads (Scalar)", async ({ request }) => {
    const res = await request.get("/docs");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("api-reference");
  });
});
