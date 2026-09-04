import { z } from "zod";

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
}

/** 알림톡 전송 (BSP 프로바이더 HTTP). fetch 주입으로 테스트 가능. */
export async function sendAlimtalk(
  config: KakaoConfig,
  phone: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<AlimtalkResult> {
  try {
    const res = await fetchImpl(config.provider_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.api_key}` },
      body: JSON.stringify({ senderKey: config.sender_key, to: phone, text }),
      redirect: "error", // 사설 대상 리다이렉트 우회 차단
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
