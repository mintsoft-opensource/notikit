/**
 * A/B 변형 배정 — 토큰 해시로 결정적 분배(재클레임으로 이어 보내도 같은 변형이 나온다).
 *
 * 발송(push-processor)과 클릭 기록(messages/click)이 **같은 함수**를 써야 변형별 클릭률이 맞는다.
 * 클릭 라우트가 발송기를 통째로 불러오지 않도록 여기에 따로 둔다.
 */
export function variantIndex(token: string, n: number): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** 이 발송에서 그 토큰에 배정된 변형 — 변형이 없는 발송이면 null */
export function variantForToken(token: string, variantCount: number | null | undefined): number | null {
  return variantCount && variantCount > 0 ? variantIndex(token, variantCount) : null;
}
