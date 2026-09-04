import { NextResponse } from "next/server";

export type ApiEnvelope<T> = {
  success: boolean;
  data: T | null;
  error: string | null;
  meta?: Record<string, unknown>;
};

export function ok<T>(data: T, meta?: Record<string, unknown>, status = 200) {
  return NextResponse.json<ApiEnvelope<T>>(
    { success: true, data, error: null, ...(meta ? { meta } : {}) },
    { status }
  );
}

export function fail(error: string, status = 400) {
  return NextResponse.json<ApiEnvelope<null>>(
    { success: false, data: null, error },
    { status }
  );
}
