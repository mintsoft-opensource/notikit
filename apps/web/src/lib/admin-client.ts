"use client";

import * as React from "react";

export type Project = { id: string; name: string; apiKey: string; environment: string };
export type SessionUser = { email: string; role: string };

/** admin API 호출 — 세션 쿠키(same-origin 자동 전송) 기반. 실패 시 throw(Error). */
export async function adminApi<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (res.status === 401) {
    // 세션 만료 → 로그인으로
    if (typeof window !== "undefined") window.location.href = "/login";
    throw new Error("세션이 만료되었습니다");
  }
  if (!res.ok || !json.success) throw new Error(json.error ?? `요청 실패 (HTTP ${res.status})`);
  return json.data as T;
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
  await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
  window.location.href = "/login";
}

/** 프로젝트 목록 훅 (마운트 시 자동 로드) */
export function useProjects() {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const reload = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<{ projects: Project[] }>("/api/admin/projects");
      setProjects(data.projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return { projects, error, loading, reload };
}
