"use client";

import * as React from "react";
import { useTranslations } from "next-intl";

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

/**
 * 클라이언트가 스스로 만든 오류의 코드. 문구는 호출부가 번역한다(`useAdminErrorText`).
 * `server` 는 서버가 준 메시지를 그대로 쓴다.
 */
export type AdminErrorCode = "session_expired" | "request_failed" | "logout_failed" | "server";

/**
 * admin API 오류. `message` 는 번역 없이 보여 줘도 읽히는 영어 대체 문구다 —
 * 아직 코드를 번역하지 않는 호출부(`e.message` 를 그대로 토스트)도 빈 문구가 뜨지 않게.
 */
export class AdminApiError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

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
    if (typeof json?.error === "string" && json.error) throw new AdminApiError("server", res.status, json.error);
    throw new AdminApiError("request_failed", res.status, `Request failed (HTTP ${res.status})`);
  }
  return json.data as T;
}

/** 오류 → 화면 문구. 클라이언트 코드는 번역하고, 서버 메시지는 그대로, 그 밖은 fallback. */
export function useAdminErrorText() {
  const t = useTranslations("common");
  return React.useCallback(
    (e: unknown, fallback: string): string => {
      if (e instanceof AdminApiError) {
        if (e.code === "session_expired") return t("errSessionExpired");
        if (e.code === "request_failed") return t("errRequestFailed", { status: e.status });
        if (e.code === "logout_failed") return t("errLogoutFailed");
        return e.message || fallback;
      }
      return e instanceof Error && e.message ? e.message : fallback;
    },
    [t]
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
