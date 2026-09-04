import { createHash } from "node:crypto";
import { getApps, initializeApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { ServiceAccount } from "./firebase-credentials";

export interface FcmMessage {
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  data?: Record<string, unknown>;
}

export interface FcmResult {
  success: number;
  failure: number;
  invalidTokens: string[];
}

/** 크레덴셜 지문 — 회전 시 새 App 이 만들어지도록 이름에 포함 */
function credFingerprint(sa: ServiceAccount): string {
  return createHash("sha256").update(`${sa.client_email}:${sa.private_key}`).digest("hex").slice(0, 12);
}

/** 프로젝트+크레덴셜별 firebase-admin App 재사용 (크레덴셜 회전 시 자동 갱신) */
function appForProject(projectId: string, sa: ServiceAccount): App {
  const name = `notikit-${projectId}-${credFingerprint(sa)}`;
  const existing = getApps().find((a) => a.name === name);
  if (existing) return existing;
  return initializeApp(
    { credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) },
    name
  );
}

function buildData(msg: FcmMessage): Record<string, string> {
  const data: Record<string, string> = {};
  if (msg.deepLink) data.deep_link = msg.deepLink;
  for (const [k, v] of Object.entries(msg.data ?? {})) {
    data[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return data;
}

// 토큰 자체가 무효인 경우만 (payload 오류인 invalid-argument 는 제외 — 정상 토큰 오삭제 방지)
const INVALID_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/** 최대 500개 토큰에 멀티캐스트 전송 → 성공/실패/무효토큰 반환 */
export async function sendToTokens(
  projectId: string,
  sa: ServiceAccount,
  tokens: string[],
  msg: FcmMessage
): Promise<FcmResult> {
  if (tokens.length === 0) return { success: 0, failure: 0, invalidTokens: [] };

  const messaging = getMessaging(appForProject(projectId, sa));
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body, imageUrl: msg.imageUrl },
    data: buildData(msg),
  });

  const invalidTokens: string[] = [];
  res.responses.forEach((r, i) => {
    if (!r.success && r.error && INVALID_CODES.has(r.error.code)) {
      invalidTokens.push(tokens[i]);
    }
  });

  return { success: res.successCount, failure: res.failureCount, invalidTokens };
}
