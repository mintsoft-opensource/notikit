/**
 * A/B 변형 배정 — **기기 id** 해시로 결정적 분배(재클레임으로 이어 보내도 같은 변형이 나온다).
 *
 * 토큰이 아니라 기기 id 인 이유: FCM 토큰은 교체된다(`devices/rotate` 는 같은 기기 행의 토큰만 바꾼다).
 * 토큰으로 가르면 발송과 클릭 사이에 토큰이 바뀐 기기의 클릭이 엉뚱한 변형으로 기록된다.
 *
 * 발송(push-processor)과 클릭 기록(messages/click)이 **같은 함수**를 써야 변형별 클릭률이 맞는다.
 * 클릭 라우트가 발송기를 통째로 불러오지 않도록 여기에 따로 둔다.
 */
export function variantIndex(key: string, n: number): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** 이 발송에서 그 기기에 배정된 변형 — 변형이 없는 발송이면 null */
export function variantForDevice(deviceId: string, variantCount: number | null | undefined): number | null {
  return variantCount && variantCount > 0 ? variantIndex(deviceId, variantCount) : null;
}
