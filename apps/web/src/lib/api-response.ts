import { NextResponse } from "next/server";

export type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
  /** 실패 사유의 고정 코드 — 콘솔이 이걸로 번역한다. `error` 는 API/curl 사용자용 사람 문구로 남는다 */
  code?: string;
  /** `code` 문구에 끼워 넣을 값(버전 등) */
  params?: Record<string, string | number>;
  meta?: Record<string, unknown>;
};

export type FailOptions = { code?: string; params?: Record<string, string | number> };

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  return NextResponse.json<ApiEnvelope<T>>(
    { success: true, data, error: null, ...(meta ? { meta } : {}) },
    { status }
  );
}

export function fail(error: string, status = 400, opts?: FailOptions) {
  return NextResponse.json<ApiEnvelope<null>>(
    {
      success: false,
      data: null,
      error,
      ...(opts?.code ? { code: opts.code } : {}),
      ...(opts?.params ? { params: opts.params } : {}),
    },
    { status }
  );
}
