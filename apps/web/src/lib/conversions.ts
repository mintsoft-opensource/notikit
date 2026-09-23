import { z } from "zod";

/**
 * 전환 귀속 창 — 클릭 후 이 시간 안에 들어온 이벤트만 그 발송의 성과로 본다.
 *
 * 창을 길게 잡으면 푸시와 무관한 행동까지 성과로 잡히고, 짧게 잡으면 "알림 보고 나중에 샀다"를
 * 놓친다. 24시간은 푸시가 만드는 행동의 대부분이 들어오는 구간이면서, 다음 날 발송과 섞이지 않는다.
 */
export const CONVERSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 귀속 대상 클릭의 하한 시각 — 이보다 **나중에** 클릭한 것만 귀속한다 */
export function attributionCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - CONVERSION_WINDOW_MS);
}

/** 그 클릭이 아직 귀속 창 안인가. 경계(정확히 24시간 전)는 창 밖이다. */
export function isAttributable(clickedAt: Date, now: Date = new Date()): boolean {
  return clickedAt.getTime() > attributionCutoff(now).getTime();
}

/** 전환 금액 상한(최소 화폐 단위) — 오타 한 자리로 매출 집계가 망가지는 것을 막는 방어선 */
export const VALUE_CENTS_MAX = 1_000_000_000;

/**
 * 전환 이벤트 입력. 대상은 토큰(기기 하나) 또는 user_id(그 사람) 중 **정확히 하나**다.
 * user_id 로 보낼 때는 identity_hash 가 필수 — 공개 api-key 만으로 남의 전환을 심지 못하게 한다.
 *
 * 공개 이름은 `user_id` 지만 여기서는 `external_id` 로 받는다 — `readJsonLimited` 가 본문을 읽으면서
 * 두 이름을 하나로 맞춰 주기 때문이다(`applyUserIdAlias`). 예전 이름으로 보내는 앱도 그대로 동작한다.
 */
export const conversionEventSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    value_cents: z.number().int().min(0).max(VALUE_CENTS_MAX).optional(),
    token: z.string().min(1).max(4096).optional(),
    external_id: z.string().min(1).max(255).optional(),
    identity_hash: z.string().max(128).optional(),
  })
  .refine((b) => !!b.token !== !!b.external_id, "exactly one of token or user_id is required");

export type ConversionEventInput = z.infer<typeof conversionEventSchema>;
