import { z } from "zod";
import { safeFetch } from "@/lib/safe-fetch";

/** 카카오 알림톡 설정 (BSP 프로바이더 경유 — NHN/Solapi/Aligo 등) */
export const kakaoConfigSchema = z.object({
  provider_url: z.string().url(),
  api_key: z.string().min(1),
  sender_key: z.string().min(1),
});
export type KakaoConfig = z.infer<typeof kakaoConfigSchema>;

export function parseKakaoConfig(input: unknown): KakaoConfig {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  const parsed = kakaoConfigSchema.safeParse(obj);
  if (!parsed.success) throw new Error("유효한 카카오 설정이 아닙니다 (provider_url/api_key/sender_key)");
  return parsed.data;
}

export interface AlimtalkResult {
  ok: boolean;
  status: number;
  attempts: number;
}

/** 알림톡 재시도 대기(ms) — 푸시 실패 뒤의 마지막 수단이라 길게 끌지 않는다. */
const RETRY_DELAY_MS = 1_000;

/**
 * 일시적 실패인가. 0(네트워크·타임아웃) · 429 · 5xx 만 다시 쏜다.
 * 4xx 는 템플릿·수신번호 문제라 같은 요청을 다시 보내도 결과가 같다.
 */
export function isTransientAlimtalkFailure(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function postOnce(
  config: KakaoConfig,
  phone: string,
  text: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetchImpl(config.provider_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify({ senderKey: config.sender_key, to: phone, text }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

/**
 * 알림톡 전송 (BSP 프로바이더 HTTP). fetch 주입으로 테스트 가능.
 *
 * 일시적 실패면 한 번만 더 쏜다. 알림톡은 푸시가 실패했을 때의 대체 경로라 재시도 큐가 없고,
 * 여기서 놓치면 그 메시지는 사용자에게 영영 닿지 않는다. 대신 BSP 과금이 붙는 경로이므로 1회로 못 박는다.
 */
export async function sendAlimtalk(
  config: KakaoConfig,
  phone: string,
  text: string,
  fetchImpl: (url: string, init: RequestInit) => Promise<Response> = safeFetch,
  opts: { retries?: number; retryDelayMs?: number } = {}
): Promise<AlimtalkResult> {
  const retries = Math.max(0, opts.retries ?? 1);
  const delayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;

  let last = { ok: false, status: 0 };
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await wait(delayMs);
    last = await postOnce(config, phone, text, fetchImpl);
    if (last.ok || !isTransientAlimtalkFailure(last.status)) return { ...last, attempts: i + 1 };
  }
  return { ...last, attempts: retries + 1 };
}
