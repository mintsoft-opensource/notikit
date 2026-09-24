/**
 * A/B 자동 승자 — 표본에게 먼저 보내고, 정해진 시간을 기다렸다가 **유니크 클릭률**이 가장 좋은
 * 변형을 나머지에게 한 번 더 보낸다.
 *
 * 표본과 나머지는 토큰 해시의 **버킷**으로 가른다. "앞에서 N행"으로 자르면 안 된다:
 * 승자 본발송은 나중에 따로 도는 발송이라 그 사이 기기가 늘거나 줄고, 커서 순서도 보장되지
 * 않아 표본으로 이미 받은 사람이 본발송에도 섞인다(같은 내용을 두 번 받는다).
 * 버킷은 토큰만 보고 정해지므로 두 발송의 대상이 **정의상 겹치지 않는다**.
 *
 * 버킷 해시는 `variantIndex` 와 **다른 해시**다. 같은 해시를 100으로 나눠 쓰면 버킷과 변형
 * 배정이 붙어, 표본 비율이 변형 수의 배수가 아닐 때 표본 안에서 변형이 고르게 나뉘지 않는다
 * (예: 변형 2개 · 표본 5% → 버킷 0~4 의 홀짝이 3:2). 그러면 비교 자체가 기울어진다.
 *
 * 판정은 장난감이 되지 않도록 두 가지를 막는다:
 * - 변형마다 최소 표본(`AB_MIN_VARIANT_SAMPLE`)을 채우지 못하면 승자를 말하지 않는다.
 * - 1·2위 클릭률 차이가 `AB_TIE_MARGIN` 미만이면 동률로 본다.
 * 둘 다 "조용히 A 를 고르는" 대신 이유를 남겨 화면이 그대로 보여 준다.
 *
 * 이 파일은 **콘솔(브라우저) 번들에도 들어간다** — 화면과 서버가 같은 상수·판정을 써야
 * "화면은 통과시키고 서버가 422" 가 생기지 않는다. 그러니 여기에 db·drizzle 을 import 하지 말 것.
 */

/** 표본 비율(%)의 허용 범위 — 절반을 넘으면 "표본"이 아니다 */
export const AB_SAMPLE_MIN = 5;
export const AB_SAMPLE_MAX = 50;
/** 판정 대기(분). 클릭이 쌓일 시간이 필요해 최소 5분, 하루를 넘겨 기다리지는 않는다 */
export const AB_WAIT_MIN_MINUTES = 5;
export const AB_WAIT_MAX_MINUTES = 1440;
/** 변형마다 실제로 도달해야 하는 최소 건수. 이보다 적으면 클릭률 차이는 우연이다. */
export const AB_MIN_VARIANT_SAMPLE = 100;
/** 1·2위 클릭률 차이의 하한(0.01 = 1%p). 이보다 작으면 승자를 선언하지 않는다. */
export const AB_TIE_MARGIN = 0.01;
/** 버킷 수 = 100 이라 버킷 번호가 그대로 백분율이 된다 */
const AB_BUCKETS = 100;

/** 지표는 유니크 클릭률 하나로 고정한다 — 고를 수 있게 두면 판정 규칙이 지표마다 갈라진다 */
export type AbMetric = "unique_click_rate";

export type AbVariantResult = {
  variant: number;
  sent: number;
  success: number;
  /** 유니크 클릭(기기당 1회) */
  clicks: number;
  /** clicks / success. 도달이 0이면 null(0% 가 아니다) */
  rate: number | null;
};

/** 승자를 못 정했으면 그 이유가 곧 화면 문구가 된다 */
export type AbDecisionReason = "winner" | "insufficient_sample" | "tie" | "no_clicks";

export type AbDecision = {
  /** 판정 시각(ISO) */
  at: string;
  winner: number | null;
  reason: AbDecisionReason;
  /** 판정에 쓴 표본 결과 — 나중에 다시 계산하지 않도록 그대로 굳힌다 */
  results: AbVariantResult[];
  /** 승자 본발송 로그 id */
  followUpLogId?: string;
};

/** 표본 발송(원본 로그)에 붙는 설정 */
export type AbTestPlan = {
  role: "test";
  samplePercent: number;
  waitMinutes: number;
  metric: AbMetric;
  /** 표본 발송이 끝난 뒤 확정되는 판정 시각(ISO). 화면이 "언제 정해지는지"를 보여 준다. */
  decideAt?: string;
  decision?: AbDecision;
};

/** 승자 본발송(추가로 만들어지는 로그)에 붙는 표식 */
export type AbWinnerSend = {
  role: "winner";
  /** 표본 발송 로그 */
  parentLogId: string;
  /** 표본 비율 — 이 로그는 **버킷이 이 값 이상**인 기기에게만 간다 */
  samplePercent: number;
  /** 보내는 변형 번호(0=A) */
  variant: number;
};

export type AbTest = AbTestPlan | AbWinnerSend;

export function abPlan(v: AbTest | null | undefined): AbTestPlan | null {
  return v && v.role === "test" ? v : null;
}

export function abWinnerSend(v: AbTest | null | undefined): AbWinnerSend | null {
  return v && v.role === "winner" ? v : null;
}

/**
 * 토큰 → 0~99 버킷 (FNV-1a). `variantIndex` 와 섞이지 않게 다른 해시를 쓴다.
 * 같은 토큰은 언제 계산해도 같은 버킷이라 표본/나머지 판정이 재클레임에도 흔들리지 않는다.
 */
export function abBucket(token: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % AB_BUCKETS;
}

export function inAbSample(token: string, samplePercent: number): boolean {
  return abBucket(token) < samplePercent;
}

/** 이 발송이 대상의 어느 쪽을 맡는지 */
export type AbPart = { part: "sample" | "remainder"; samplePercent: number };

export function abPart(v: AbTest | null | undefined): AbPart | null {
  if (!v) return null;
  return v.role === "test"
    ? { part: "sample", samplePercent: v.samplePercent }
    : { part: "remainder", samplePercent: v.samplePercent };
}

/** 이 발송이 맡은 쪽의 기기만 남긴다(순수 함수). 표본과 나머지는 서로소다. */
export function abTargets<T extends { token: string }>(part: AbPart | null, rows: T[]): T[] {
  if (!part) return rows;
  const want = part.part === "sample";
  return rows.filter((r) => inAbSample(r.token, part.samplePercent) === want);
}

/**
 * 분모(도달 예정 인원) 추정. 실제 대상은 버킷으로 갈리므로 전체 수에 비율을 곱한다 —
 * 해시가 완벽히 균등하지는 않아 어림값이고, 화면도 그렇게 읽히는 자리(클릭률 분모)에만 쓴다.
 */
export function abScale(n: number, part: AbPart | null): number {
  if (!part) return n;
  const pct = part.part === "sample" ? part.samplePercent : 100 - part.samplePercent;
  return Math.round((n * pct) / 100);
}

/** 변형별 표본 결과 — 발송 집계(variantStats)와 유니크 클릭 수를 한 줄로 합친다(순수 함수) */
export function abResults(
  variantCount: number,
  stats: Record<string, { sent: number; success: number }> | null,
  clicks: Map<number, number>
): AbVariantResult[] {
  return Array.from({ length: variantCount }, (_, i) => {
    const s = stats?.[String(i)] ?? { sent: 0, success: 0 };
    const c = clicks.get(i) ?? 0;
    return { variant: i, sent: s.sent, success: s.success, clicks: c, rate: s.success > 0 ? c / s.success : null };
  });
}

/**
 * 승자 판정(순수 함수). 최소 표본과 동률 가드를 넘지 못하면 `winner: null` 과 **이유**를 남긴다 —
 * 조용히 A 를 고르면 운영자는 A/B 를 했다고 믿는데 실제로는 아무것도 재지 않은 것이 된다.
 */
export function decideWinner(results: AbVariantResult[], at: Date): AbDecision {
  const base = { at: at.toISOString(), results };
  if (results.length < 2 || results.some((r) => r.success < AB_MIN_VARIANT_SAMPLE)) {
    return { ...base, winner: null, reason: "insufficient_sample" };
  }
  if (results.every((r) => r.clicks === 0)) return { ...base, winner: null, reason: "no_clicks" };

  const ranked = [...results].sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
  const [top, second] = ranked;
  // 부동소수점 여유. 없으면 "정확히 1%p 차이"가 0.009999… 로 계산돼 규칙과 반대로 동률이 된다.
  if ((top.rate ?? 0) - (second.rate ?? 0) < AB_TIE_MARGIN - 1e-9) return { ...base, winner: null, reason: "tie" };
  return { ...base, winner: top.variant, reason: "winner" };
}

/** 승자 본발송의 멱등 키 — 재클레임이 판정을 다시 돌아도 로그는 한 행만 생긴다 */
export function abWinnerKey(logId: string): string {
  return `ab-winner:${logId}`;
}
