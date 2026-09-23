import { eq } from "drizzle-orm";
import { z } from "zod";
import { pushConversions } from "@/db/schema";
import type { getDb } from "@/db/client";

type Db = ReturnType<typeof getDb>;

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

/**
 * 전환 금액 상한(최소 화폐 단위).
 *
 * 이 값은 "이보다 큰 단일 전환은 없다"가 아니라 **오염 한 건이 집계를 얼마나 망칠 수 있는가**로
 * 정한다. 엔드포인트는 공개 api-key 만으로 열리므로, 상한이 곧 한 건이 낼 수 있는 최대 피해다.
 * 1e9(= USD 1,000만 / KRW 10억)은 한 건으로 그 달 매출을 통째로 덮을 수 있어 방어선이 아니었다.
 * 1e8 은 KRW 1억 · USD 100만 · JPY 1억으로, 고가 상품을 파는 쪽도 걸리지 않으면서
 * 한 건이 낼 수 있는 왜곡을 한 자릿수 줄인다. 더 큰 금액은 서버-투-서버 집계로 보낸다.
 */
export const VALUE_CENTS_MAX = 100_000_000;

/** 이름 길이 상한 — 지표 축의 레이블이지 자유 텍스트 필드가 아니다. */
export const CONVERSION_NAME_MAX_LENGTH = 64;

/**
 * 프로젝트당 허용하는 서로 다른 전환 이름 수.
 *
 * `name` 은 집계의 축(dimension)이다. 축이 무한하면 전환 리포트는 읽을 수 없어지고,
 * 공개 api-key 를 쥔 쪽이 매 요청 새 이름을 보내 테이블과 인덱스를 무한히 불릴 수 있다.
 * 상한을 넘은 **새 이름**은 422 로 거절한다 — 이미 쓰던 이름은 계속 받으므로 정상 SDK 는 영향이 없다.
 */
export const MAX_CONVERSION_NAMES_PER_PROJECT = 50;
/** 이름 목록 캐시 수명. 다른 replica 가 추가한 이름은 이 주기 안에 반영된다. */
export const CONVERSION_NAME_CACHE_MS = 60_000;
/** 캐시가 붙잡는 프로젝트 수 상한 — 프로젝트가 많아도 메모리가 선형으로 늘지 않게 */
const MAX_CACHED_PROJECTS = 1_000;

/**
 * 이름 정규화 — 같은 축이 공백/유니코드 표기 차이로 갈라지는 것을 막는다.
 * 대소문자는 건드리지 않는다(리포트에 그대로 보이는 값이라 표기를 보존한다).
 */
export function normalizeConversionName(raw: string): string {
  return raw.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * 전환 이벤트 입력. 대상은 토큰(기기 하나) 또는 user_id(그 사람) 중 **정확히 하나**다.
 * user_id 로 보낼 때는 identity_hash 가 필수 — 공개 api-key 만으로 남의 전환을 심지 못하게 한다.
 *
 * 공개 이름은 `user_id` 지만 여기서는 `external_id` 로 받는다 — `readJsonLimited` 가 본문을 읽으면서
 * 두 이름을 하나로 맞춰 주기 때문이다(`applyUserIdAlias`). 예전 이름으로 보내는 앱도 그대로 동작한다.
 */
export const conversionEventSchema = z
  .object({
    // 제어문자는 거른다 — 개행이 섞인 이름은 리포트와 CSV 내보내기를 깨뜨린다.
    // 그 밖의 문자(한글 등)는 그대로 허용해야 기존 SDK 사용이 깨지지 않는다.
    name: z
      .string()
      .transform(normalizeConversionName)
      .pipe(z.string().min(1).max(CONVERSION_NAME_MAX_LENGTH).regex(/^[^\p{C}]+$/u, "name must not contain control characters")),
    value_cents: z.number().int().min(0).max(VALUE_CENTS_MAX).optional(),
    token: z.string().min(1).max(4096).optional(),
    external_id: z.string().min(1).max(255).optional(),
    identity_hash: z.string().max(128).optional(),
  })
  .refine((b) => !!b.token !== !!b.external_id, "exactly one of token or user_id is required");

export type ConversionEventInput = z.infer<typeof conversionEventSchema>;

// ── 이름 카디널리티 게이트 ──
type NameCacheEntry = { names: Set<string>; loadedAt: number };
const nameCache = new Map<string, NameCacheEntry>();

/** 이미 이 프로젝트가 쓰고 있는 전환 이름 — 상한 +1 까지만 읽는다(넘었는지만 알면 된다). */
export async function loadConversionNames(db: Db, projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: pushConversions.name })
    .from(pushConversions)
    .where(eq(pushConversions.projectId, projectId))
    .limit(MAX_CONVERSION_NAMES_PER_PROJECT + 1);
  return rows.map((r) => r.name);
}

/**
 * 이 이름을 받아도 되는가. 이미 쓰던 이름이면 언제나 true, 새 이름은 상한 안에서만 true.
 *
 * 거절된 이름은 캐시에 넣지 않는다 — 넣으면 새 이름을 쏟아붓는 것만으로 메모리가 늘어
 * 막으려던 공격을 다른 자원에서 다시 허용하게 된다.
 *
 * 상한은 **프로젝트당 soft cap** 이다. 캐시 수명(최대 CONVERSION_NAME_CACHE_MS)과 replica 수만큼
 * 잠깐 넘을 수 있지만, 무한 증가는 막힌다. 정확한 상한이 필요하면 DB 유니크로 올려야 한다.
 */
export async function admitConversionName(
  projectId: string,
  name: string,
  load: () => Promise<string[]>,
  now: number = Date.now()
): Promise<boolean> {
  let entry = nameCache.get(projectId);
  if (!entry || now - entry.loadedAt >= CONVERSION_NAME_CACHE_MS) {
    const known = await load();
    entry = { names: new Set(known), loadedAt: now };
    if (!nameCache.has(projectId) && nameCache.size >= MAX_CACHED_PROJECTS) {
      const oldest = nameCache.keys().next().value; // Map 은 삽입 순서 보존
      if (oldest !== undefined) nameCache.delete(oldest);
    }
    nameCache.set(projectId, entry);
  }
  if (entry.names.has(name)) return true;
  if (entry.names.size >= MAX_CONVERSION_NAMES_PER_PROJECT) return false;
  entry.names.add(name);
  return true;
}

/** 테스트/운영용 — 이름 캐시 비우기 */
export function resetConversionNameCache(): void {
  nameCache.clear();
}
