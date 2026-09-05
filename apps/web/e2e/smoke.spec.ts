import { test, expect, type Page } from "@playwright/test";

const ADMIN = { email: "e2e-admin@notikit.dev", password: "e2e-password-1234" };

/** 세션 쿠키 확보 — 최초 실행은 부트스트랩 register, 이후는 login (page 컨텍스트에 쿠키 저장) */
async function ensureLogin(page: Page) {
  const reg = await page.request.post("/api/admin/register", { data: { org_name: "E2E", ...ADMIN } });
  if (!reg.ok()) {
    const login = await page.request.post("/api/admin/login", { data: ADMIN });
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

  test("docs page loads (Scalar)", async ({ request }) => {
    const res = await request.get("/docs");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(html).toContain("api-reference");
  });
});
