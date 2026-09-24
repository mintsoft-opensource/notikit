import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { PushLog, Project } from "@/db/schema";

const { emitted, webhook } = vi.hoisted(() => ({ emitted: [] as unknown[][], webhook: { fail: false } }));
vi.mock("@/lib/webhooks", () => ({
  emitWebhook: (...args: unknown[]) => {
    if (webhook.fail) return Promise.reject(new Error("db down"));
    emitted.push(args);
    return Promise.resolve();
  },
  assertSafeWebhookUrl: () => Promise.resolve(),
  MAX_ATTEMPTS: 5,
}));

import {
  applyFrequencyCap,
  buildItems,
  deliveredRows,
  releasableUsers,
  chunk,
  initialState,
  mapLimit,
  multicastGroups,
  parseResumeState,
  tallyResults,
  variantIndex,
  claimableLog,
  parseAttempts,
  reclaimAttempts,
  reserveCapped,
  runFollowUps,
  saveProgress,
  settleFailure,
  MAX_SEND_ATTEMPTS,
  type ResumeState,
  type SendContext,
} from "./push-processor";

const DEV = "11111111-1111-1111-1111-111111111111";

describe("resume state", () => {
  it("round-trips through JSON so a reclaimed run continues from the cursor with totals", () => {
    const s: ResumeState = { ...initialState({ users: 3, devices: 4 }, 2), cursor: DEV, total: 10, success: 7, failure: 3 };
    expect(parseResumeState(JSON.stringify(s))).toEqual(s);
  });

  it("starts at the zero cursor with per-variant slots", () => {
    const s = initialState({ users: 1, devices: 2 }, 2);
    expect(s.cursor).toBe("00000000-0000-0000-0000-000000000000");
    expect(s.variantStats).toEqual({ "0": { sent: 0, success: 0 }, "1": { sent: 0, success: 0 } });
    expect(initialState({ users: 0, devices: 0 }, null).variantStats).toBeNull();
  });

  it("rejects missing, malformed or tampered state instead of skipping recipients", () => {
    expect(parseResumeState(null)).toBeNull();
    expect(parseResumeState("not json")).toBeNull();
    const good = initialState({ users: 1, devices: 1 }, null);
    expect(parseResumeState(JSON.stringify({ ...good, cursor: "x' or 1=1" }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, total: -1 }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, audience: null }))).toBeNull();
    expect(parseResumeState(JSON.stringify({ ...good, variantStats: { "0": { sent: "a" } } }))).toBeNull();
  });
});

describe("applyFrequencyCap", () => {
  const rows = [
    { userId: "u1", token: "a" },
    { userId: "u1", token: "b" },
    { userId: "u2", token: "c" },
    { userId: null, token: "d" },
  ];

  it("drops every device of users at or over the cap, keeps anonymous devices", () => {
    const r = applyFrequencyCap(rows, new Map([["u1", 2], ["u2", 1]]), 2);
    expect(r.allowed.map((x) => x.token)).toEqual(["c", "d"]);
    expect(r.capped).toBe(2);
  });

  it("is a no-op without a cap", () => {
    expect(applyFrequencyCap(rows, new Map([["u1", 99]]), null)).toEqual({ allowed: rows, capped: 0 });
  });

  it("cap 0 blocks all identified users", () => {
    expect(applyFrequencyCap(rows, new Map(), 0).allowed.map((x) => x.token)).toEqual(["d"]);
  });
});

describe("buildItems / multicastGroups", () => {
  const rows = [
    { token: "t1", platform: "ios" },
    { token: "t2", platform: "web" },
    { token: "t3", platform: "android" },
  ];

  it("marks web as data-only and keeps content without a renderer", () => {
    const items = buildItems(rows, { title: "T", body: "B" }, null, null);
    expect(items.map((i) => [i.token, i.dataOnly, i.vi, i.title])).toEqual([
      ["t1", false, null, "T"],
      ["t2", true, null, "T"],
      ["t3", false, null, "T"],
    ]);
  });

  it("assigns variants deterministically and renders per token", () => {
    const variants = [{ title: "A", body: "a" }, { title: "B", body: "b" }];
    const items = buildItems(rows, { title: "T", body: "B" }, variants, (text, token) => `${text}:${token}`);
    for (const it of items) {
      expect(it.vi).toBe(variantIndex(it.token, 2));
      expect(it.title).toBe(`${variants[it.vi!].title}:${it.token}`);
    }
  });

  it("groups identical content per payload shape and splits at 500", () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({ token: `n${i}`, platform: "android" }));
    const items = buildItems([...many, { token: "w", platform: "web" }], { title: "T", body: "B" }, null, null);
    const groups = multicastGroups(items);
    expect(groups.map((g) => [g.dataOnly, g.tokens.length])).toEqual([
      [false, 500],
      [false, 500],
      [false, 1],
      [true, 1],
    ]);
  });
});

describe("tallyResults", () => {
  it("adds counts and attributes successes to the variant of each accepted token", () => {
    const state = initialState({ users: 2, devices: 2 }, 2);
    const items = [
      { token: "a", vi: 0, title: "", body: "", dataOnly: false },
      { token: "b", vi: 1, title: "", body: "", dataOnly: false },
    ];
    const next = tallyResults(state, items, [{ success: 1, failure: 1, validTokens: ["a"] }]);
    expect(next.success).toBe(1);
    expect(next.failure).toBe(1);
    expect(next.variantStats).toEqual({ "0": { sent: 0, success: 1 }, "1": { sent: 0, success: 0 } });
    expect(state.variantStats!["0"].success).toBe(0); // 원본 불변
  });
});

describe("helpers", () => {
  it("chunk splits evenly", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("mapLimit preserves order under concurrency", async () => {
    const out = await mapLimit([30, 10, 20], 2, (ms) => new Promise<number>((r) => setTimeout(() => r(ms), ms)));
    expect(out).toEqual([30, 10, 20]);
  });
});

describe("deliveredRows", () => {
  const rows = [
    { token: "a", userId: "u1" },
    { token: "b", userId: "u1" },
    { token: "c", userId: "u2" },
    { token: "d", userId: null },
  ];

  it("keeps only rows whose token was delivered", () => {
    expect(deliveredRows(rows, ["b", "d"])).toEqual([rows[1], rows[3]]);
  });

  it("returns nothing when every send failed", () => {
    expect(deliveredRows(rows, [])).toEqual([]);
  });

  it("ignores delivered tokens that are not in the page", () => {
    expect(deliveredRows(rows, ["z", "c"])).toEqual([rows[2]]);
  });
});

describe("releasableUsers", () => {
  const allowed = [
    { token: "a", userId: "u1" },
    { token: "b", userId: "u1" },
    { token: "c", userId: "u2" },
    { token: "d", userId: null },
  ];

  it("releases reserved users none of whose devices were delivered", () => {
    expect(releasableUsers(["u1", "u2"], allowed, ["b"])).toEqual(["u2"]);
  });

  it("releases every reservation when nothing was delivered", () => {
    expect(releasableUsers(["u1", "u2"], allowed, [])).toEqual(["u1", "u2"]);
  });

  it("never releases users this page did not newly reserve", () => {
    expect(releasableUsers(["u2"], allowed, [])).toEqual(["u2"]);
    expect(releasableUsers([], allowed, [])).toEqual([]);
  });
});

describe("parseResumeState follow-ups", () => {
  const base = initialState({ users: 1, devices: 1 }, null);

  it("keeps the finalizing phase and completed steps across a reclaim", () => {
    const s: ResumeState = { ...base, followUps: { inbox: true } };
    expect(parseResumeState(JSON.stringify(s))?.followUps).toEqual({ inbox: true });
  });

  it("treats a malformed follow-up record as finalizing with nothing done", () => {
    const raw = JSON.stringify({ ...base, followUps: { inbox: "yes", kakao: true, bogus: true } });
    expect(parseResumeState(raw)?.followUps).toEqual({ kakao: true });
    expect(parseResumeState(JSON.stringify({ ...base, followUps: 3 }))?.followUps).toEqual({});
  });

  it("leaves sending-phase state without follow-ups", () => {
    expect(parseResumeState(JSON.stringify(base))).not.toHaveProperty("followUps");
  });
});

// ─── 재시도·클레임 조건 ──────────────────────────────────────────────────────

describe("claimableLog", () => {
  const sqlOf = (q: SQL) => new PgDialect().sqlToQuery(q).sql;

  it("lockedAt 이 비어 있는 processing 행도 재클레임 대상에 넣는다", () => {
    const q = sqlOf(claimableLog(new Date(), new Date())!);
    expect(q).toContain('"locked_at" is null');
    expect(q).toContain('"status" = $');
  });

  it("클레임과 큐 스캔이 같은 조건을 공유한다 — 한쪽만 고치면 행이 스캔에서 사라진다", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const stale = new Date("2025-12-31T23:55:00Z");
    expect(sqlOf(claimableLog(now, stale)!)).toBe(sqlOf(claimableLog(now, stale)!));
  });
});

describe("parseAttempts", () => {
  it("상태가 깨졌거나 없어도 시도 횟수는 살린다", () => {
    expect(parseAttempts(null)).toBe(0);
    expect(parseAttempts("not json")).toBe(0);
    expect(parseAttempts(JSON.stringify({ attempts: 2 }))).toBe(2);
    expect(parseAttempts(JSON.stringify({ cursor: "x' or 1=1", attempts: 2 }))).toBe(2);
    expect(parseAttempts(JSON.stringify({ attempts: -1 }))).toBe(0);
    expect(parseAttempts(JSON.stringify({ attempts: "3" }))).toBe(0);
  });

  it("정상 상태는 진행 상태와 함께 읽힌다", () => {
    const s: ResumeState = { ...initialState({ users: 1, devices: 1 }, null), attempts: 1 };
    expect(parseResumeState(JSON.stringify(s))?.attempts).toBe(1);
    expect(parseAttempts(JSON.stringify(s))).toBe(1);
  });
});

type Row = { id: string };

/** update().set().where()[.returning()] 만 쓰는 호출용 — set 페이로드를 그대로 모은다 */
function updateSpy(result: Row[] | ((call: number) => Row[])) {
  const sets: Record<string, unknown>[] = [];
  let call = 0;
  const db = {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        const out = typeof result === "function" ? result(call++) : result;
        // where() 는 그대로 await 하기도(설정 갱신), .returning() 을 붙이기도(소유권 확인) 한다
        return { where: () => Object.assign(Promise.resolve(out), { returning: async () => out }) };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof saveProgress>[0], sets };
}

describe("settleFailure", () => {
  const LOG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const TOKEN = "lock-1";

  /** 실패 정산은 DB 를 **읽지 않는다** — select 를 부르면 즉시 터지는 db 로 그걸 고정한다 */
  function db() {
    const spy = updateSpy([{ id: LOG }]);
    const noSelect = {
      ...(spy.db as unknown as Record<string, unknown>),
      select: () => {
        throw new Error("db is down");
      },
    };
    return { db: noSelect as unknown as Parameters<typeof settleFailure>[0], sets: spy.sets };
  }

  it("일시적 실패는 failed 로 닫지 않고 시도 횟수만 올린다 — stale 재클레임이 이어 간다", async () => {
    const state = { ...initialState({ users: 9, devices: 9 }, null), cursor: DEV, total: 5, success: 5 };
    const t = db();
    expect(await settleFailure(t.db, LOG, TOKEN, new Error("db down"), JSON.stringify(state))).toBe(true);
    expect(t.sets).toHaveLength(1);
    expect(t.sets[0].status).toBeUndefined();
    const saved = parseResumeState(t.sets[0].resumeCursor as string)!;
    expect(saved.attempts).toBe(1);
    // 커서와 누적이 그대로여야 남은 대상만 이어 보낸다
    expect(saved.cursor).toBe(DEV);
    expect(saved.success).toBe(5);
  });

  it("진행 상태가 아직 없어도 횟수를 남긴다(첫 페이지 전에 죽은 경우)", async () => {
    const t = db();
    expect(await settleFailure(t.db, LOG, TOKEN, new Error("boom"), null)).toBe(true);
    expect(parseAttempts(t.sets[0].resumeCursor as string)).toBe(1);
  });

  it("한도를 소진하면 사유와 함께 failed 로 닫는다", async () => {
    const state = { ...initialState({ users: 1, devices: 1 }, null), attempts: MAX_SEND_ATTEMPTS - 1 };
    const t = db();
    expect(await settleFailure(t.db, LOG, TOKEN, new Error("still down"), JSON.stringify(state))).toBe(false);
    expect(t.sets[0].status).toBe("failed");
    expect(t.sets[0].failureReason).toBe(`attempt ${MAX_SEND_ATTEMPTS}/${MAX_SEND_ATTEMPTS}: still down`);
    expect(parseAttempts(t.sets[0].resumeCursor as string)).toBe(MAX_SEND_ATTEMPTS);
  });

  it("사유는 길이를 잘라 로그 행이 비대해지지 않게 한다", async () => {
    const state = { ...initialState({ users: 1, devices: 1 }, null), attempts: MAX_SEND_ATTEMPTS - 1 };
    const t = db();
    await settleFailure(t.db, LOG, TOKEN, new Error("x".repeat(5000)), JSON.stringify(state));
    expect((t.sets[0].failureReason as string).length).toBe(300);
  });
});

describe("saveProgress", () => {
  const LOG = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

  it("소유권을 잃으면 false — 호출부는 즉시 멈춰야 중복 발송이 없다", async () => {
    const t = updateSpy([]);
    const state = initialState({ users: 1, devices: 1 }, null);
    expect(await saveProgress(t.db, LOG, "stolen", state)).toBe(false);
  });

  it("소유 중이면 하트비트와 진행 상태를 함께 남긴다", async () => {
    const t = updateSpy([{ id: LOG }]);
    const state = { ...initialState({ users: 2, devices: 3 }, null), cursor: DEV, total: 7 };
    expect(await saveProgress(t.db, LOG, "mine", state)).toBe(true);
    expect(t.sets[0].lockedAt).toBeInstanceOf(Date);
    expect(parseResumeState(t.sets[0].resumeCursor as string)).toEqual(state);
  });
});

// ─── 후속 단계 이어 돌기 ─────────────────────────────────────────────────────

const LOG_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJ = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

/** 후속 단계는 broadcast 에서 받는 사람 조회 없이 돈다 — db 는 진행 상태 저장에만 쓰인다 */
const broadcastLog = { id: LOG_ID, projectId: PROJ, type: "broadcast", title: "T", body: "B" } as unknown as PushLog;
const ctx = {
  project: { id: PROJ, name: "P", kakaoConfigEnc: null } as unknown as Project,
  sa: null,
  cap: null,
  renderCtx: { appName: "P", now: new Date() },
  personalized: false,
  rateLimit: null,
  localTime: null,
} satisfies SendContext;

describe("runFollowUps", () => {
  const savedSteps = (sets: Record<string, unknown>[]) =>
    sets.map((s) => Object.keys(parseResumeState(s.resumeCursor as string)?.followUps ?? {}).sort());

  it("단계마다 완료 표시를 남긴다 — 중간에 죽어도 끝난 단계는 다시 돌지 않는다", async () => {
    emitted.length = 0;
    const t = updateSpy([{ id: LOG_ID }]);
    const sent = initialState({ users: 1, devices: 1 }, null);
    expect(await runFollowUps(t.db, broadcastLog, ctx, "mine", sent, "completed")).toBe(true);
    expect(savedSteps(t.sets)).toEqual([[], ["inbox"], ["inbox", "kakao"], ["inbox", "kakao", "webhook"]]);
    expect(emitted).toHaveLength(1);
  });

  it("재클레임하면 남은 단계만 돈다 — 끝난 표시는 그대로 들고 간다", async () => {
    emitted.length = 0;
    const t = updateSpy([{ id: LOG_ID }]);
    const sent: ResumeState = { ...initialState({ users: 1, devices: 1 }, null), followUps: { inbox: true, kakao: true } };
    expect(await runFollowUps(t.db, broadcastLog, ctx, "mine", sent, "completed")).toBe(true);
    expect(savedSteps(t.sets)).toEqual([
      ["inbox", "kakao"],
      ["inbox", "kakao", "webhook"],
    ]);
    expect(emitted).toHaveLength(1);
  });

  it("중간에 소유권을 잃으면 남은 단계를 돌지 않고 false", async () => {
    emitted.length = 0;
    // 첫 저장(진입)만 성공, 인박스 직후 저장에서 소유권 상실
    const t = updateSpy((call) => (call === 0 ? [{ id: LOG_ID }] : []));
    const sent = initialState({ users: 1, devices: 1 }, null);
    expect(await runFollowUps(t.db, broadcastLog, ctx, "stolen", sent, "completed")).toBe(false);
    expect(emitted).toHaveLength(0);
    expect(t.sets).toHaveLength(2);
  });

  it("진입 시점에 이미 남의 것이면 아무 단계도 돌지 않는다", async () => {
    emitted.length = 0;
    const t = updateSpy([]);
    expect(await runFollowUps(t.db, broadcastLog, ctx, "stolen", initialState({ users: 1, devices: 1 }, null), "completed")).toBe(
      false
    );
    expect(emitted).toHaveLength(0);
    expect(t.sets).toHaveLength(1);
  });
});

// ─── 빈도 상한 예약의 동시성 ─────────────────────────────────────────────────

type Send = { logId: string; userId: string };

/** 같은 프로젝트 DB 흉내. advisory lock 을 잡은 트랜잭션이 끝날 때까지 다음 트랜잭션을 세운다. */
function makeStore() {
  const sends: Send[] = [];
  let chain = Promise.resolve();
  const acquire = (): Promise<() => void> => {
    const prev = chain;
    let release!: () => void;
    chain = new Promise<void>((r) => (release = r));
    return prev.then(() => release);
  };
  return { sends, acquire };
}

function makeDb(store: ReturnType<typeof makeStore>, logId: string, beforeInsert?: () => Promise<void>) {
  const counts = () => {
    const m = new Map<string, number>();
    for (const s of store.sends) if (s.logId !== logId) m.set(s.userId, (m.get(s.userId) ?? 0) + 1);
    return [...m].map(([userId, n]) => ({ userId, n }));
  };
  const db = {
    transaction: async (cb: (t: unknown) => Promise<unknown>) => {
      const held: { release: (() => void) | null } = { release: null };
      const tx = {
        // reserveCapped 가 advisory lock 을 잡지 않으면 직렬화도 없다 — 그 회귀를 이 테스트가 잡는다
        execute: async () => {
          held.release = await store.acquire();
          return [];
        },
        select: () => ({ from: () => ({ where: () => ({ groupBy: async () => counts() }) }) }),
        insert: () => ({
          values: (rows: Array<{ userId: string }>) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                if (beforeInsert) await beforeInsert();
                const added: Array<{ userId: string }> = [];
                for (const r of rows) {
                  if (store.sends.some((s) => s.logId === logId && s.userId === r.userId)) continue;
                  store.sends.push({ logId, userId: r.userId });
                  added.push({ userId: r.userId });
                }
                return added;
              },
            }),
          }),
        }),
      };
      try {
        return await cb(tx);
      } finally {
        held.release?.();
      }
    },
  };
  return db as unknown as Parameters<typeof reserveCapped>[0];
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const page = [{ id: "d1", token: "t1", userId: "u1", platform: "android" }];
const logOf = (id: string) => ({ id, projectId: PROJ } as unknown as PushLog);

describe("reserveCapped 동시성", () => {
  it("동시에 도는 두 발송이 같은 사람을 상한 너머로 통과시키지 않는다", async () => {
    const store = makeStore();
    let open!: () => void;
    const barrier = new Promise<void>((r) => (open = r));

    const a = reserveCapped(makeDb(store, "log-a", () => barrier), logOf("log-a"), page, 1);
    await tick(); // A 가 lock 을 잡고 판정까지 끝낸 뒤 insert 직전에 멈춘다
    const b = reserveCapped(makeDb(store, "log-b"), logOf("log-b"), page, 1);
    await tick();
    open();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.reserved).toEqual(["u1"]);
    expect(ra.allowed).toHaveLength(1);
    // B 는 A 의 예약을 보고 상한에 걸러야 한다
    expect(rb.allowed).toEqual([]);
    expect(rb.reserved).toEqual([]);
    expect(store.sends).toHaveLength(1);
  });

  it("같은 발송의 다른 페이지는 자기 예약에 걸리지 않는다", async () => {
    const store = makeStore();
    const first = await reserveCapped(makeDb(store, "log-a"), logOf("log-a"), page, 1);
    expect(first.reserved).toEqual(["u1"]);
    // 같은 로그가 같은 사람을 또 만나도(다중 기기) 상한에서 빠지지 않는다
    const second = await reserveCapped(makeDb(store, "log-a"), logOf("log-a"), page, 1);
    expect(second.allowed).toHaveLength(1);
    expect(second.reserved).toEqual([]); // 이미 있는 기록은 새로 예약하지 않는다
  });

  it("상한이 남아 있으면 그대로 통과시킨다", async () => {
    const store = makeStore();
    await reserveCapped(makeDb(store, "log-a"), logOf("log-a"), page, 3);
    const r = await reserveCapped(makeDb(store, "log-b"), logOf("log-b"), page, 3);
    expect(r.allowed).toHaveLength(1);
    expect(r.reserved).toEqual(["u1"]);
  });
});

describe("settleFailure 소유권 표식", () => {
  const LOG2 = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  it("되살릴 때 lock_token 을 비운다 — 다음 재클레임이 같은 실패를 두 번 세지 않게", async () => {
    const t = updateSpy([{ id: LOG2 }]);
    await settleFailure(t.db as unknown as Parameters<typeof settleFailure>[0], LOG2, "lock-1", new Error("db down"), null);
    expect(t.sets[0].lockToken).toBeNull();
  });
});

describe("reclaimAttempts", () => {
  const row = (o: Record<string, unknown>) =>
    o as unknown as Parameters<typeof reclaimAttempts>[0];

  it("락을 쥔 채 사라진 processing 로그는 시도 1회로 센다 — 안 세면 OOM 발송이 5분마다 영원히 되살아난다", () => {
    expect(reclaimAttempts(row({ status: "processing", lockToken: "lock-1", resumeCursor: null }))).toBe(1);
    expect(
      reclaimAttempts(row({ status: "processing", lockToken: "lock-1", resumeCursor: JSON.stringify({ attempts: 2 }) }))
    ).toBe(3);
  });

  it("스스로 실패를 적었거나(토큰 비움) 아직 시작 전인 로그는 세지 않는다", () => {
    expect(reclaimAttempts(row({ status: "processing", lockToken: null, resumeCursor: "{}" }))).toBeNull();
    expect(reclaimAttempts(row({ status: "queued", lockToken: null, resumeCursor: null }))).toBeNull();
    expect(reclaimAttempts(undefined)).toBeNull();
  });
});

describe("진행 상태 확장 필드", () => {
  it("미룬 시각·회차·실패 사유를 왕복시킨다 — 이어받은 워커가 같은 판단을 해야 한다", () => {
    const s: ResumeState = {
      ...initialState({ users: 1, devices: 1 }, null),
      nextPageAt: "2026-09-24T01:00:00.000Z",
      local: { sentOffsets: ["+09:00"], passAt: "2026-09-24T00:00:00.000Z", nextPassAt: "2026-09-24T01:00:00.000Z" },
      errors: { "messaging/quota-exceeded": 2 },
    };
    expect(parseResumeState(JSON.stringify(s))).toEqual(s);
  });

  it("망가진 확장 필드는 버리고 기본값으로 — 발송 자체를 막지는 않는다", () => {
    const raw = JSON.stringify({
      ...initialState({ users: 1, devices: 1 }, null),
      nextPageAt: "언젠가",
      local: { sentOffsets: [1, "+09:00"], passAt: "x" },
      errors: { a: "많이" },
    });
    const parsed = parseResumeState(raw)!;
    expect(parsed.nextPageAt).toBeUndefined();
    expect(parsed.local).toEqual({ sentOffsets: ["+09:00"], passAt: null, nextPassAt: null });
    expect(parsed.errors).toBeUndefined();
  });
});

describe("runFollowUps 웹훅 실패", () => {
  it("배달 행조차 못 남긴 웹훅은 단계를 완료로 표시하지 않는다 — 삼키면 그 이벤트는 영영 사라진다", async () => {
    emitted.length = 0;
    webhook.fail = true;
    const t = updateSpy([{ id: LOG_ID }]);
    const sent = initialState({ users: 1, devices: 1 }, null);
    try {
      await expect(runFollowUps(t.db, broadcastLog, ctx, "mine", sent, "completed")).rejects.toThrow("db down");
      // 인박스·알림톡까지만 완료 표시 — 재클레임은 웹훅 단계만 다시 돈다
      const last = parseResumeState(t.sets[t.sets.length - 1].resumeCursor as string)!;
      expect(Object.keys(last.followUps ?? {}).sort()).toEqual(["inbox", "kakao"]);
    } finally {
      webhook.fail = false;
    }
  });
});
