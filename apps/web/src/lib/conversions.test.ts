import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  admitConversionName,
  attributionCutoff,
  conversionEventSchema,
  isAttributable,
  normalizeConversionName,
  resetConversionNameCache,
  CONVERSION_NAME_CACHE_MS,
  CONVERSION_WINDOW_MS,
  MAX_CONVERSION_NAMES_PER_PROJECT,
  VALUE_CENTS_MAX,
} from "./conversions";
import { variantForToken, variantIndex } from "./push-variant";
import { applyUserIdAlias } from "./user-id-alias";

const now = new Date("2026-03-01T12:00:00Z");

describe("전환 귀속 창", () => {
  it("cutoff 는 정확히 24시간 전", () => {
    expect(attributionCutoff(now).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(CONVERSION_WINDOW_MS).toBe(86_400_000);
  });

  it("창 안의 클릭만 귀속한다 — 경계(정확히 24시간 전)는 밖", () => {
    expect(isAttributable(new Date(now.getTime() - 1), now)).toBe(true);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS + 1), now)).toBe(true);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS), now)).toBe(false);
    expect(isAttributable(new Date(now.getTime() - CONVERSION_WINDOW_MS - 1), now)).toBe(false);
  });
});

describe("conversionEventSchema", () => {
  // 라우트는 applyUserIdAlias 를 거친 본문을 파싱한다 — 공개 이름 user_id 는 여기서 external_id 다
  const parse = (body: unknown) => conversionEventSchema.safeParse(applyUserIdAlias(body));

  it("token 과 user_id 중 정확히 하나만 받는다", () => {
    expect(parse({ name: "purchase", token: "t1" }).success).toBe(true);
    expect(parse({ name: "purchase", user_id: "u1", identity_hash: "h" }).success).toBe(true);
    expect(parse({ name: "purchase" }).success).toBe(false);
    expect(parse({ name: "purchase", token: "t1", user_id: "u1" }).success).toBe(false);
  });

  it("예전 이름 external_id 로 보내도 같게 동작한다", () => {
    expect(parse({ name: "purchase", external_id: "u1", identity_hash: "h" }).success).toBe(true);
    expect(parse({ name: "purchase", token: "t1", external_id: "u1" }).success).toBe(false);
  });

  it("이름은 공백을 떼고 1~64자, 금액은 0 이상 정수", () => {
    const r = parse({ name: "  purchase  ", token: "t1" });
    expect(r.success && r.data.name).toBe("purchase");
    expect(parse({ name: "   ", token: "t1" }).success).toBe(false);
    expect(parse({ name: "x".repeat(65), token: "t1" }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: -1 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: 1.5 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: VALUE_CENTS_MAX + 1 }).success).toBe(false);
    expect(parse({ name: "p", token: "t1", value_cents: 0 }).success).toBe(true);
  });

  it("금액 상한은 한 건이 집계를 덮지 못할 만큼 낮다", () => {
    // 공개 api-key 로 열리는 경로라 상한이 곧 한 건의 최대 피해다
    expect(VALUE_CENTS_MAX).toBe(100_000_000);
    expect(parse({ name: "p", token: "t1", value_cents: VALUE_CENTS_MAX }).success).toBe(true);
    expect(parse({ name: "p", token: "t1", value_cents: 1_000_000_000 }).success).toBe(false);
  });

  it("이름을 정규화해 같은 축이 표기 차이로 갈라지지 않게 한다", () => {
    expect(normalizeConversionName("  buy   now\t")).toBe("buy now");
    const r = parse({ name: "buy   now", token: "t1" });
    expect(r.success && r.data.name).toBe("buy now");
    expect(parse({ name: "구매", token: "t1" }).success).toBe(true); // 비ASCII 는 계속 허용
  });

  it("제어문자가 섞인 이름은 거절한다 — 리포트/CSV 를 깨뜨린다", () => {
    expect(parse({ name: "buy\u0000now", token: "t1" }).success).toBe(false);
    // 개행은 정규화가 공백으로 접는다(거절이 아니라 같은 이름으로 모인다)
    const r = parse({ name: "buy\nnow", token: "t1" });
    expect(r.success && r.data.name).toBe("buy now");
  });
});

describe("admitConversionName (프로젝트별 이름 카디널리티 상한)", () => {
  beforeEach(() => resetConversionNameCache());

  const load = (names: string[]) => vi.fn(async () => names);

  it("이미 쓰던 이름은 상한과 무관하게 언제나 통과한다", async () => {
    const full = Array.from({ length: MAX_CONVERSION_NAMES_PER_PROJECT }, (_, i) => `n${i}`);
    const loader = load(full);
    expect(await admitConversionName("p1", "n0", loader)).toBe(true);
    expect(await admitConversionName("p1", "n49", loader)).toBe(true);
  });

  it("상한을 넘는 새 이름만 거절한다", async () => {
    const loader = load([]);
    for (let i = 0; i < MAX_CONVERSION_NAMES_PER_PROJECT; i++) {
      expect(await admitConversionName("p1", `n${i}`, loader)).toBe(true);
    }
    expect(await admitConversionName("p1", "overflow", loader)).toBe(false);
    expect(await admitConversionName("p1", "n0", loader)).toBe(true); // 기존 이름은 계속 받는다
  });

  it("거절된 이름은 캐시에 남기지 않는다 — 쏟아부어도 메모리가 늘지 않게", async () => {
    const loader = load(Array.from({ length: MAX_CONVERSION_NAMES_PER_PROJECT }, (_, i) => `n${i}`));
    for (let i = 0; i < 500; i++) expect(await admitConversionName("p1", `junk-${i}`, loader)).toBe(false);
    // 상한을 넘겨 자란 흔적이 없다면, 다음 창에서도 기존 이름은 그대로 통과한다
    expect(await admitConversionName("p1", "n0", loader)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1); // 요청마다 DB 를 때리지 않는다
  });

  it("프로젝트끼리 상한을 나눠 쓰지 않는다", async () => {
    const loader = load([]);
    for (let i = 0; i < MAX_CONVERSION_NAMES_PER_PROJECT; i++) await admitConversionName("p1", `n${i}`, loader);
    expect(await admitConversionName("p1", "more", loader)).toBe(false);
    expect(await admitConversionName("p2", "more", loader)).toBe(true);
  });

  it("캐시가 만료되면 다른 replica 가 추가한 이름을 다시 읽는다", async () => {
    const loader = vi.fn(async () => ["from-db"]);
    const t0 = 1_000_000;
    expect(await admitConversionName("p1", "from-db", loader, t0)).toBe(true);
    expect(await admitConversionName("p1", "from-db", loader, t0 + CONVERSION_NAME_CACHE_MS - 1)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(await admitConversionName("p1", "from-db", loader, t0 + CONVERSION_NAME_CACHE_MS)).toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("variantForToken", () => {
  it("변형이 없는 발송이면 null", () => {
    expect(variantForToken("tok", null)).toBeNull();
    expect(variantForToken("tok", 0)).toBeNull();
    expect(variantForToken("tok", undefined)).toBeNull();
  });

  it("클릭에 기록하는 변형은 발송이 배정한 것과 같다", () => {
    for (const token of ["a", "tok-1", "가나다", "x".repeat(200)]) {
      expect(variantForToken(token, 2)).toBe(variantIndex(token, 2));
      expect(variantForToken(token, 3)).toBe(variantIndex(token, 3));
    }
  });

  it("같은 토큰은 항상 같은 변형 — 재클레임으로 이어 보내도 뒤집히지 않는다", () => {
    expect(variantForToken("tok", 2)).toBe(variantForToken("tok", 2));
    expect(variantForToken("tok", 2)).toBeLessThan(2);
  });
});
