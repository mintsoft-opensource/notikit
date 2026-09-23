/**
 * `user_id` ↔ `external_id` — 고객사 서비스의 회원 ID.
 *
 * 공개 이름은 `user_id` 다. `external_id` 는 예전 이름이라 이미 연동한 앱·SDK 가 계속 보내므로
 * 같이 받는다. 서버 안쪽(스키마·DB 컬럼 external_id)은 그대로 두고, 요청을 읽는 입구에서만 맞춘다.
 */

/** JSON 본문의 `user_id` 를 `external_id` 로 옮긴다. `null`(바인딩 해제)도 그대로 옮긴다. 둘 다 있으면 user_id. */
export function applyUserIdAlias(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body) || !("user_id" in body)) return body;
  const { user_id: userId, ...rest } = body as Record<string, unknown>;
  // 둘 다 오면 공개 이름(user_id)이 이긴다 — 문서에 적힌 규칙. 예전 이름은 호환용일 뿐이다.
  return { ...rest, external_id: userId };
}

/** 쿼리스트링용 — `user_id` 가 먼저, 없으면 예전 이름 `external_id` */
export function userIdParam(params: URLSearchParams): string | null {
  return params.get("user_id") ?? params.get("external_id");
}
