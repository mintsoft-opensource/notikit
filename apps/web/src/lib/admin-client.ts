"use client";

import * as React from "react";

const TOKEN_KEY = "notikit_admin_token";

export type Project = { id: string; name: string; apiKey: string; environment: string };

export function useAdminToken() {
  const [token, setToken] = React.useState("");
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    setToken(localStorage.getItem(TOKEN_KEY) ?? "");
    setReady(true);
  }, []);

  const save = React.useCallback((t: string) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
  }, []);

  return { token, ready, save };
}

export function adminHeaders(token: string): HeadersInit {
  return { "x-admin-token": token, "content-type": "application/json" };
}

/** admin API 호출 — 성공 시 data, 실패 시 throw(Error(message)) */
export async function adminApi<T = unknown>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { ...adminHeaders(token), ...(init?.headers ?? {}) },
  });
  const json = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!res.ok || !json.success) {
    throw new Error(json.error ?? `요청 실패 (HTTP ${res.status})`);
  }
  return json.data as T;
}

/** 프로젝트 목록 훅 (token 준비 후 자동 로드) */
export function useProjects(token: string, ready: boolean) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const reload = React.useCallback(async () => {
    if (!token) {
      setProjects([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi<{ projects: Project[] }>("/api/admin/projects", token);
      setProjects(data.projects);
    } catch (e) {
      setError(e instanceof Error ? e.message : "로드 실패");
    } finally {
      setLoading(false);
    }
  }, [token]);

  React.useEffect(() => {
    if (ready) reload();
  }, [ready, reload]);

  return { projects, error, loading, reload };
}
