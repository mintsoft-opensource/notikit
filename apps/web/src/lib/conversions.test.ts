import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  admitConversionName,
  attributionCutoff,
  conversionEventSchema,
  normalizeConversionName,
  recordConversionName,
  resetConversionNameCache,
  CONVERSION_NAME_CACHE_MS,
  CONVERSION_WINDOW_MS,
  MAX_CONVERSION_NAMES_PER_PROJECT,
  VALUE_CENTS_MAX,
} from "./conversions";
import { variantForDevice, variantIndex } from "./push-variant";
import { applyUserIdAlias } from "./user-id-alias";

const now = new Date("2026-03-01T12:00:00Z");

describe("전환 귀속 창", () => {
  it("cutoff 는 정확히 24시간 전", () => {
    expect(attributionCutoff(now).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(CONVERSION_WINDOW_MS).toBe(86_400_000);
  });

  // 창 안/밖 판정은 SQL(`gt(clickedAt, attributionCutoff())`)이 한다 — 같은 규칙을 JS 로
  // 한 벌 더 두면 두 구현이 갈라지므로, 여기서는 cutoff 값만 고정한다.
  it("cutoff 보다 나중에 찍힌 클릭만 창 안이다(경계는 밖)", () => {
    const cutoff = attributionCutoff(now).getTime();
    expect(now.getTime() - 1).toBeGreaterThan(cutoff);
    expect(now.getTime() - CONVERSION_WINDOW_MS).toBe(cutoff); // 경계는 `>` 에서 탈락
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

  /** 라우트의 정상 흐름: 통과시킨 뒤 실제로 저장까지 됐을 때만 계수한다. */
  const admitAndStore = async (projectId: string, name: string, loader: () => Promise<string[]>) => {
    const admitted = await admitConversionName(projectId, name, loader);
    if (admitted) recordConversionName(projectId, name);
    return admitted;
  };

  it("이미 쓰던 이름은 상한과 무관하게 언제나 통과한다", async () => {
    const full = Array.from({ length: MAX_CONVERSION_NAMES_PER_PROJECT }, (_, i) => `n${i}`);
    const loader = load(full);
    expect(await admitConversionName("p1", "n0", loader)).toBe(true);
    expect(await admitConversionName("p1", "n49", loader)).toBe(true);
  });

  it("상한을 넘는 새 이름만 거절한다", async () => {
    const loader = load([]);
    for (let i = 0; i < MAX_CONVERSION_NAMES_PER_PROJECT; i++) {
      expect(await admitAndStore("p1", `n${i}`, loader)).toBe(true);
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
    for (let i = 0; i < MAX_CONVERSION_NAMES_PER_PROJECT; i++) await admitAndStore("p1", `n${i}`, loader);
    expect(await admitConversionName("p1", "more", loader)).toBe(false);
    expect(await admitConversionName("p2", "more", loader)).toBe(true);
  });

  // 캐시 오염: 저장으로 이어지지 않는 요청이 축을 소비하면, 공개 api-key 만으로
  // 그 프로젝트의 정상적인 새 전환 이름을 영구히 422 로 막을 수 있다.
  it("저장되지 않은 이름은 축을 소비하지 않는다 — 가짜 이름으로 상한을 채울 수 없다", async () => {
    const loader = load([]);
    // 공격자: 기기가 없거나(404) 귀속 클릭이 없어(202) 아무것도 저장되지 않는 요청 500건
    for (let i = 0; i < 500; i++) {
      expect(await admitConversionName("p1", `fake-${i}`, loader)).toBe(true);
    }
    // 정상 SDK 의 새 이름이 여전히 들어간다
    expect(await admitAndStore("p1", "purchase", loader)).toBe(true);
    expect(await admitAndStore("p1", "signup", loader)).toBe(true);
    // 실제로 저장된 2개만 축을 차지한다
    for (let i = 0; i < MAX_CONVERSION_NAMES_PER_PROJECT - 2; i++) {
      expect(await admitAndStore("p1", `real-${i}`, loader)).toBe(true);
    }
    expect(await admitConversionName("p1", "overflow", loader)).toBe(false);
  });

  it("캐시 항목이 없으면 record 는 조용히 지나간다 — 다음 조회가 DB 에서 읽는다", async () => {
    resetConversionNameCache();
    expect(() => recordConversionName("p1", "purchase")).not.toThrow();
    const loader = load(["purchase"]);
    expect(await admitConversionName("p1", "purchase", loader)).toBe(true);
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

describe("variantForDevice", () => {
  it("변형이 없는 발송이면 null", () => {
    expect(variantForDevice("tok", null)).toBeNull();
    expect(variantForDevice("tok", 0)).toBeNull();
    expect(variantForDevice("tok", undefined)).toBeNull();
  });

  it("클릭에 기록하는 변형은 발송이 배정한 것과 같다", () => {
    for (const id of ["a", "dev-1", "가나다", "x".repeat(200)]) {
      expect(variantForDevice(id, 2)).toBe(variantIndex(id, 2));
      expect(variantForDevice(id, 3)).toBe(variantIndex(id, 3));
    }
  });

  it("같은 기기는 항상 같은 변형 — 재클레임으로 이어 보내도, 토큰이 바뀌어도 뒤집히지 않는다", () => {
    expect(variantForDevice("tok", 2)).toBe(variantForDevice("tok", 2));
    expect(variantForDevice("tok", 2)).toBeLessThan(2);
  });
});
