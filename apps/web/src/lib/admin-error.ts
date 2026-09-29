/**
 * 서버가 `fail(..., { code })` 로 주는 고정 코드. 각 코드는 messages/*.json 의 `apiErrors.<code>` 문구를 가진다.
 * 서버 `error` 문구는 한국어 고정이라 그대로 띄우면 다른 언어 화면에 한국어가 섞인다 — 콘솔은 코드로만 번역한다.
 */
export const API_ERROR_CODES = [
  // 상태 코드만 있을 때 쓰는 일반 문구
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "payload_too_large",
  "rate_limited",
  "server_busy",
  // 인증·계정
  "invalid_input",
  "invalid_credentials",
  "bootstrap_token_required",
  "already_initialized",
  "not_session_account",
  "same_password",
  "wrong_current_password",
  "session_changed",
  // 조직·멤버
  "owner_only",
  "no_org_context",
  "user_not_found",
  "owner_account_owner_only",
  "owner_assign_owner_only",
  "email_taken",
  "self_role_change",
  "self_delete",
  "last_owner_demote",
  "last_owner_delete",
  // 업데이트
  "instance_operator_only",
  "update_status_failed",
  "bundle_not_found",
  "bundle_unverifiable",
  "bundle_version_mismatch",
  "already_latest",
  "update_unlicensed",
  "update_server_unreachable",
  "update_not_latest_release",
  "update_blocked",
  "update_in_progress",
  // 프로젝트 리소스
  "template_name_taken",
  "topic_name_conflict",
  "topic_deleted_retry",
  "topic_not_rule_filled",
  "import_already_reverted",
  "import_empty",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(API_ERROR_CODES);

/** 코드 없이 상태만 왔을 때의 일반 문구 — 서버 문구(한국어·영어 혼재) 대신 번역된 말을 쓴다 */
const STATUS_CODES: Readonly<Record<number, ApiErrorCode>> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  413: "payload_too_large",
  429: "rate_limited",
  503: "server_busy",
};

/**
 * 클라이언트가 스스로 만든 오류의 코드. 문구는 호출부가 번역한다(`useAdminErrorText`).
 * `server` 는 서버 응답에서 온 오류다 — `apiCode` 가 있으면 그걸로 번역한다.
 */
export type AdminErrorCode = "session_expired" | "request_failed" | "logout_failed" | "server";

export type ApiErrorParams = Record<string, string | number>;

/**
 * admin API 오류. `message` 는 번역 없이 보여 줘도 읽히는 대체 문구다 —
 * 아직 코드를 번역하지 않는 호출부(`e.message` 를 그대로 토스트)도 빈 문구가 뜨지 않게.
 */
export class AdminApiError extends Error {
  constructor(
    readonly code: AdminErrorCode,
    readonly status: number,
    message: string,
    readonly apiCode?: string,
    readonly params?: ApiErrorParams
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

/** 응답 본문의 `code`·`params` 를 믿을 수 있는 모양일 때만 꺼낸다 — 외부 데이터라 형태를 확인한다 */
export function readApiErrorDetail(json: unknown): { apiCode?: string; params?: ApiErrorParams } {
  if (!json || typeof json !== "object") return {};
  const { code, params } = json as { code?: unknown; params?: unknown };
  const apiCode = typeof code === "string" && code ? code : undefined;
  if (!params || typeof params !== "object" || Array.isArray(params)) return { apiCode };
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => typeof v === "string" || typeof v === "number")
  ) as ApiErrorParams;
  return { apiCode, params: clean };
}

export type ErrorTranslator = {
  common: (key: string, values?: ApiErrorParams) => string;
  api: (key: ApiErrorCode, values?: ApiErrorParams) => string;
};

function serverErrorText(e: AdminApiError, fallback: string, t: ErrorTranslator): string {
  // 구체적인 코드가 일반 상태 문구보다 우선한다
  if (e.apiCode) return KNOWN_CODES.has(e.apiCode) ? t.api(e.apiCode as ApiErrorCode, e.params) : fallback;
  const byStatus = STATUS_CODES[e.status];
  if (byStatus) return t.api(byStatus);
  return e.message || fallback;
}

/** 오류 → 화면 문구. 클라이언트 코드·서버 코드·상태 순으로 번역하고, 번역할 게 없으면 fallback. */
export function adminErrorText(e: unknown, fallback: string, t: ErrorTranslator): string {
  if (!(e instanceof AdminApiError)) return e instanceof Error && e.message ? e.message : fallback;
  if (e.code === "session_expired") return t.common("errSessionExpired");
  if (e.code === "logout_failed") return t.common("errLogoutFailed");
  if (e.code === "request_failed") {
    const byStatus = STATUS_CODES[e.status];
    return byStatus ? t.api(byStatus) : t.common("errRequestFailed", { status: e.status });
  }
  return serverErrorText(e, fallback, t);
}
