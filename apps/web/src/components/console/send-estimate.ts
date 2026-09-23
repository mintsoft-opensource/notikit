"use client";

import * as React from "react";
import { adminApi } from "@/lib/admin-client";
import { ESTIMATE_DEBOUNCE_MS, type EstimateRequest } from "./send-rules";

export type AudienceEstimate = { users: number; devices: number; platforms: Record<string, number> };

type Settled = { key: string; data: AudienceEstimate | null; failed: boolean };

/**
 * 발송 전 도달 인원 — 실제 발송과 같은 기준(활성 기기, 수신거부 제외)으로 서버가 센다.
 * 대상을 바꿀 때마다 요청하지 않도록 잠시 멈춘 뒤 부른다. 결과를 기다리는 동안에는
 * 직전 값을 `shown` 으로 남겨 숫자가 깜박이지 않게 하고, 검토 단계는 최신 값(`fresh`)만 쓴다.
 */
export function useAudienceEstimate(projectId: string, request: EstimateRequest | null) {
  const key = request ? JSON.stringify(request) : "";
  const [settled, setSettled] = React.useState<Settled>({ key: "", data: null, failed: false });

  React.useEffect(() => {
    if (!key) return;
    let alive = true;
    const timer = setTimeout(() => {
      adminApi<AudienceEstimate>(`/api/admin/projects/${projectId}/audience/estimate`, { method: "POST", body: key })
        .then((data) => alive && setSettled({ key, data, failed: false }))
        .catch(() => alive && setSettled({ key, data: null, failed: true }));
    }, ESTIMATE_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, key]);

  const isCurrent = key !== "" && settled.key === key;
  return {
    hasRequest: key !== "",
    loading: key !== "" && !isCurrent,
    failed: isCurrent && settled.failed,
    fresh: isCurrent ? settled.data : null,
    shown: key ? settled.data : null,
  };
}
