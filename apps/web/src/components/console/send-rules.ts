import type { SendType } from "./send-target";

/** 권장 글자 수 — OneSignal 가이드. 넘으면 iOS 잠금화면에서 잘린다 */
export const TITLE_RECOMMENDED = 50;
export const BODY_RECOMMENDED = 150;
export const IMAGE_URL_MAX = 2048;
export const ESTIMATE_DEBOUNCE_MS = 300;

/** 화면에 보이는 글자 수 — 이모지 한 개를 2로 세지 않게 코드 포인트로 센다 */
export function charLength(s: string): number {
  return Array.from(s).length;
}

export type ImageUrlState = "empty" | "valid" | "notHttps" | "invalid";

export function imageUrlState(raw: string): ImageUrlState {
  const v = raw.trim();
  if (!v) return "empty";
  if (v.length > IMAGE_URL_MAX) return "invalid";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "invalid";
  }
  if (url.protocol === "https:") return url.hostname ? "valid" : "invalid";
  return url.protocol === "http:" ? "notHttps" : "invalid";
}

export type EstimateRequest = { type: SendType; target?: string; targets?: string[] };

/** 도달 인원 추정 요청 — 대상이 덜 정해졌으면 null(요청하지 않는다) */
export function estimateRequest(type: SendType, topic: string, userIds: string[]): EstimateRequest | null {
  if (type === "broadcast") return { type };
  if (type === "topic") return topic ? { type, target: topic } : null;
  if (userIds.length === 0) return null;
  return type === "single" ? { type, target: userIds[0] } : { type, targets: userIds };
}

export type SendWarning = "titleLong" | "bodyLong" | "imageNotHttps" | "imageInvalid" | "noDevices" | "broadcast" | "logOnly";

export function collectWarnings(input: {
  type: SendType;
  title: string;
  body: string;
  imageUrl: string;
  devices: number | null;
  hasFirebase: boolean | undefined;
}): SendWarning[] {
  const out: SendWarning[] = [];
  if (input.type === "broadcast") out.push("broadcast");
  if (input.devices === 0) out.push("noDevices");
  if (charLength(input.title) > TITLE_RECOMMENDED) out.push("titleLong");
  if (charLength(input.body) > BODY_RECOMMENDED) out.push("bodyLong");
  const image = imageUrlState(input.imageUrl);
  if (image === "notHttps") out.push("imageNotHttps");
  if (image === "invalid") out.push("imageInvalid");
  if (input.hasFirebase === false) out.push("logOnly");
  return out;
}

/** 플랫폼 표시 순서 — 모르는 플랫폼은 뒤에 이름순으로 */
const PLATFORM_ORDER = ["ios", "android", "web"];

export function platformEntries(platforms: Record<string, number>): Array<[string, number]> {
  return Object.entries(platforms)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => {
      const ia = PLATFORM_ORDER.indexOf(a);
      const ib = PLATFORM_ORDER.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });
}
