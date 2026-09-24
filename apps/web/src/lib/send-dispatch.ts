/**
 * 보낼 내용 만들기 + FCM 에 실제로 내보내기.
 *
 * 토큰별 **일시 실패는 여기서 다시 시도한다**. 예전에는 실패 수만 세고 커서가 넘어가 로그가
 * 완료됐다 — 쿼터·5xx 로 못 받은 수신자는 사유도 없이 영영 못 받았다.
 */
import type { PushLog } from "@/db/schema";
import type { Project } from "@/db/schema";
import type { ServiceAccount } from "@/lib/firebase-credentials";
import type { RenderContext } from "@/lib/personalize";
import { sendToTokens, sendEachToTokens, SEND_EACH_LIMIT, type FcmMessage, type FcmResult } from "@/lib/fcm";
import { variantIndex } from "@/lib/push-variant";
import type { AbPart } from "@/lib/ab-test";
import type { ScopedDevice } from "@/lib/audience-count";

const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 5; // 동시 FCM 호출 수
/**
 * 일시 실패 재시도 간격. 합이 STALE_MS(5분)보다 압도적으로 짧아야 한다 —
 * 길어지면 다른 워커가 이 로그를 재클레임해 같은 페이지를 또 보낸다.
 */
export const TOKEN_RETRY_DELAYS = [250, 1000];

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** 동시성 제한 map */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return results;
}

export type SendContext = {
  project: Project;
  sa: ServiceAccount | null;
  /** 테스트 발송은 null — 상한을 적용하지도, 수신 기록을 남기지도 않는다 */
  cap: number | null;
  renderCtx: RenderContext;
  personalized: boolean;
  /** 분당 발송 상한. null 이면 제한 없음 */
  rateLimit: number | null;
  /** 받는 사람 현지 시각("HH:MM") — 없으면 도래 즉시 전원에게 */
  localTime: { hour: number; minute: number } | null;
  /**
   * A/B 자동 승자에서 이 발송이 맡은 쪽(표본 · 나머지). null 이면 대상 전체에게 간다.
   * 판정은 토큰 해시 버킷이라 표본 발송과 승자 본발송의 대상은 서로소다.
   */
  ab: AbPart | null;
};

export type SendItem = { token: string; vi: number | null; title: string; body: string; dataOnly: boolean };

/**
 * 기기마다 보낼 내용: A/B 변형 배정 → 치환. 웹은 data-only(사유는 fcm.ts 의 dataOnly 참조).
 * `render` 가 없으면 치환하지 않는다(순수 함수).
 */
export function buildItems(
  rows: Array<Pick<ScopedDevice, "token" | "platform">>,
  base: { title: string; body: string },
  variants: { title: string; body: string }[] | null,
  render: ((text: string, token: string) => string) | null
): SendItem[] {
  return rows.map((r) => {
    const vi = variants ? variantIndex(r.token, variants.length) : null;
    const content = vi === null ? base : variants![vi];
    return {
      token: r.token,
      vi,
      title: render ? render(content.title, r.token) : content.title,
      body: render ? render(content.body, r.token) : content.body,
      dataOnly: r.platform === "web",
    };
  });
}

/** 같은 내용·같은 페이로드 모양끼리 묶어 멀티캐스트 배치로(최대 500) */
export function multicastGroups(items: SendItem[]): Array<Omit<SendItem, "token"> & { tokens: string[] }> {
  const groups = new Map<string, Omit<SendItem, "token"> & { tokens: string[] }>();
  for (const it of items) {
    const key = `${it.vi}\u0000${it.dataOnly}\u0000${it.title}\u0000${it.body}`;
    const g = groups.get(key) ?? { vi: it.vi, title: it.title, body: it.body, dataOnly: it.dataOnly, tokens: [] };
    g.tokens.push(it.token);
    groups.set(key, g);
  }
  return [...groups.values()].flatMap((g) => chunk(g.tokens, BATCH).map((tokens) => ({ ...g, tokens })));
}

async function sendItems(ctx: SendContext, log: PushLog, items: SendItem[]): Promise<FcmResult[]> {
  const msgOf = (c: { title: string; body: string }): FcmMessage => ({
    title: c.title,
    body: c.body,
    imageUrl: log.imageUrl ?? undefined,
    deepLink: log.deepLink ?? undefined,
    logId: log.id,
    data: log.data ?? undefined,
    options: log.options ?? undefined,
  });
  const pid = ctx.project.id;
  const sa = ctx.sa!;
  // 치환이 있으면 사람마다 내용이 달라 묶이지 않는다 — 메시지 배열 한 번(sendEach)으로 보낸다
  const jobs: Array<() => Promise<FcmResult>> = ctx.personalized
    ? chunk(items, SEND_EACH_LIMIT).map((batch) => () =>
        sendEachToTokens(pid, sa, batch.map((it) => ({ token: it.token, msg: msgOf(it), dataOnly: it.dataOnly }))))
    : multicastGroups(items).map((g) => () => sendToTokens(pid, sa, g.tokens, msgOf(g), false, g.dataOnly));
  return mapLimit(jobs, CONCURRENCY, (job) => job());
}

/** 페이지 한 장의 최종 결과 — 여러 번의 시도를 토큰 단위로 합친 값 */
export type Dispatched = { result: FcmResult; errors: string[] };

type Outcome = { valid: Set<string>; invalid: Set<string>; failures: Map<string, string> };

function absorb(out: Outcome, results: FcmResult[]): string[] {
  const retry: string[] = [];
  for (const r of results) {
    for (const t of r.validTokens) {
      out.valid.add(t);
      out.failures.delete(t); // 재시도로 성공했다
    }
    for (const t of r.invalidTokens) out.invalid.add(t);
    for (const f of r.failures) {
      if (out.valid.has(f.token)) continue;
      out.failures.set(f.token, f.code);
      if (f.retryable) retry.push(f.token);
    }
  }
  return retry;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 한 페이지를 보낸다. 일시 실패(쿼터·5xx)는 같은 토큰으로 제한 횟수만큼 다시 시도하고,
 * 끝내 실패한 것은 **사유를 남긴다**. 성공/실패 수는 토큰 단위 최종 결과로 다시 센다 —
 * 시도별 결과를 그대로 더하면 재시도한 토큰이 두 번 세어진다.
 */
export async function dispatchItems(
  ctx: SendContext,
  log: PushLog,
  items: SendItem[],
  wait: (ms: number) => Promise<unknown> = sleep
): Promise<Dispatched> {
  const out: Outcome = { valid: new Set(), invalid: new Set(), failures: new Map() };
  const byToken = new Map(items.map((it) => [it.token, it]));
  let pending = items;

  for (let round = 0; ; round++) {
    const retry = absorb(out, await sendItems(ctx, log, pending));
    if (retry.length === 0 || round >= TOKEN_RETRY_DELAYS.length) break;
    await wait(TOKEN_RETRY_DELAYS[round]);
    pending = retry.map((t) => byToken.get(t)!).filter(Boolean);
    if (pending.length === 0) break;
  }

  const validTokens = [...out.valid];
  const failures = [...out.failures].map(([token, code]) => ({ token, code, retryable: false }));
  return {
    result: {
      success: validTokens.length,
      failure: items.length - validTokens.length,
      invalidTokens: [...out.invalid].filter((t) => !out.valid.has(t)),
      validTokens,
      failures,
    },
    errors: failures.map((f) => f.code),
  };
}
