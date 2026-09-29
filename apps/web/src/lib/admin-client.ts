"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AdminApiError, adminErrorText, readApiErrorDetail } from "@/lib/admin-error";

export { AdminApiError, type AdminErrorCode } from "@/lib/admin-error";

export type Project = {
  id: string;
  name: string;
  apiKey: string;
  environment: string;
  requireIdentityVerification?: boolean;
  quietStartHour?: number | null;
  quietEndHour?: number | null;
  hasFirebase?: boolean;
  hasKakao?: boolean;
};
export type SessionUser = { email: string; role: string };

/** admin API 호출 — 세션 쿠키(same-origin 자동 전송) 기반. 실패 시 AdminApiError 를 던진다. */
export async function adminApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => null);
  if (res.status === 401) {
    // 세션 만료 → 로그인으로
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new AdminApiError("session_expired", 401, "Session expired");
  }
  if (!res.ok || !json?.success) {
    if (typeof json?.error === "string" && json.error) {
      const { apiCode, params } = readApiErrorDetail(json);
      throw new AdminApiError("server", res.status, json.error, apiCode, params);
    }
    throw new AdminApiError("request_failed", res.status, `Request failed (HTTP ${res.status})`);
  }
  return json.data as T;
}

/** 오류 → 화면 문구. 서버 코드는 `apiErrors` 로 번역하고, 코드가 없을 때만 상태·서버 문구로 내려간다 */
export function useAdminErrorText() {
  const common = useTranslations("common");
  const api = useTranslations("apiErrors");
  return React.useCallback(
    (e: unknown, fallback: string): string => adminErrorText(e, fallback, { common, api }),
    [common, api]
  );
}

/** 현재 로그인 세션 */
export function useSession() {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [ready, setReady] = React.useState(false);
  React.useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/admin/me");
        const j = await r.json();
        setUser(j.data?.user ?? null);
      } catch {
        setUser(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);
  return { user, ready };
}

export async function logout() {
  const res = await fetch("/api/admin/logout", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) throw new AdminApiError("logout_failed", res.status, "Logout failed — please try again");
  window.location.href = "/login";
}

/** 프로젝트 목록 훅 (마운트 시 자동 로드). `error` 는 번역된 문구다. */
export function useProjects() {
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  // 첫 로드가 끝나기 전엔 로딩 중이다 — false 로 시작하면 빈 배열이 잠깐 "프로젝트 없음"으로 보인다
  const [loading, setLoading] = React.useState(true);
  // 요청 세대 — 연달아 reload 하면 늦게 온 옛 응답이 최신 목록을 덮지 않게
  const reqRef = React.useRef(0);

  const reload = React.useCallback(async () => {
    const my = ++reqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<{ projects: Project[] }>("/api/admin/projects");
      if (my === reqRef.current) setProjects(data.projects);
    } catch (e) {
      if (my === reqRef.current) setError(errorText(e, tc("loadFailed")));
    } finally {
      if (my === reqRef.current) setLoading(false);
    }
  }, [errorText, tc]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return { projects, error, loading, reload };
}
