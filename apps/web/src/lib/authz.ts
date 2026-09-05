import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { adminUsers, projects } from "@/db/schema";
import { sessionTokenFromRequest, verifySessionToken, type SessionToken } from "@/lib/session";

/** 세션 토큰이 현재 유효한지 DB 검증 (서명 OK + 유저 존재 + sessionVersion 일치). 레이아웃 가드용. */
export async function isSessionValid(tokenValue: string | undefined | null): Promise<boolean> {
  const st: SessionToken | null = verifySessionToken(tokenValue);
  if (!st) return false;
  const user = (
    await getDb().select({ ver: adminUsers.sessionVersion }).from(adminUsers).where(eq(adminUsers.id, st.userId)).limit(1)
  )[0];
  return !!user && user.ver === st.ver;
}

export type AuthContext = { userId: string | null; orgId: string | null; role: string; superadmin: boolean };

/**
 * 인증 컨텍스트 해석 (DB 검증).
 * - x-admin-token == ADMIN_TOKEN → superadmin(전체 org, role owner). 하위호환(E2E/curl).
 * - 세션 쿠키 → 유저 존재 + sessionVersion 일치 확인 후 **현재** org/role 반환
 *   (삭제/로그아웃/권한변경 즉시 반영).
 */
export async function getAuthContext(req: Request): Promise<AuthContext | null> {
  const token = req.headers.get("x-admin-token");
  const expected = process.env.ADMIN_TOKEN;
  if (expected && token && token === expected) {
    return { userId: null, orgId: null, role: "owner", superadmin: true };
  }

  const st = sessionTokenFromRequest(req);
  if (!st) return null;

  const user = (
    await getDb()
      .select({ id: adminUsers.id, orgId: adminUsers.orgId, role: adminUsers.role, ver: adminUsers.sessionVersion })
      .from(adminUsers)
      .where(eq(adminUsers.id, st.userId))
      .limit(1)
  )[0];
  if (!user || user.ver !== st.ver) return null; // 삭제됨 / 무효화됨

  return { userId: user.id, orgId: user.orgId, role: user.role, superadmin: false };
}

export function canWrite(ctx: AuthContext): boolean {
  return ctx.superadmin || ctx.role === "owner" || ctx.role === "admin";
}

export type AuthzResult = { ok: true; ctx: AuthContext } | { ok: false; status: number; error: string };

/**
 * 프로젝트 스코프 인가 — 로그인 유저는 자기 org 프로젝트만.
 * write=true 면 viewer 거부(403).
 */
export async function requireProject(req: Request, projectId: string, opts?: { write?: boolean }): Promise<AuthzResult> {
  const ctx = await getAuthContext(req);
  if (!ctx) return { ok: false, status: 401, error: "Unauthorized" };
  if (opts?.write && !canWrite(ctx)) return { ok: false, status: 403, error: "Forbidden: 쓰기 권한 없음" };

  if (!ctx.superadmin) {
    const row = (await getDb().select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, projectId)).limit(1))[0];
    // 존재하지 않거나 타 org → 404 (존재 여부 비노출)
    if (!row || row.orgId !== ctx.orgId) return { ok: false, status: 404, error: "Project not found" };
  }
  return { ok: true, ctx };
}

/** 관리 API(비-프로젝트) 인가. write=true 면 viewer 거부. */
export async function requireAuth(req: Request, opts?: { write?: boolean }): Promise<AuthzResult> {
  const ctx = await getAuthContext(req);
  if (!ctx) return { ok: false, status: 401, error: "Unauthorized" };
  if (opts?.write && !canWrite(ctx)) return { ok: false, status: 403, error: "Forbidden: 쓰기 권한 없음" };
  return { ok: true, ctx };
}

/**
 * CSRF 방어 — 상태변경(POST/PATCH/PUT/DELETE) 요청의 Origin 을 호스트와 대조.
 * superadmin(x-admin-token) 호출은 브라우저 컨텍스트가 아니므로 면제(Origin 없음 허용).
 */
export function checkOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  // **유효한** superadmin 토큰만 면제 (서버-투-서버/curl). 잘못된 토큰은 쿠키로 폴백되므로 면제 금지.
  const token = req.headers.get("x-admin-token");
  if (token && process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN) return true;

  const origin = req.headers.get("origin");
  if (!origin) return false; // 브라우저 상태변경엔 Origin 필수

  const allowed = process.env.APP_ORIGIN;
  if (allowed) return origin === allowed; // 정확 비교(scheme+host+port)

  // APP_ORIGIN 미설정: 요청 스킴(프록시면 x-forwarded-proto) + host 로 기대 Origin 구성 후 정확 비교
  const host = req.headers.get("host");
  if (!host) return false;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || new URL(req.url).protocol.replace(":", "");
  return origin === `${proto}://${host}`;
}
