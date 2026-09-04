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

/** 프로젝트별 firebase-admin App 재사용 (이름 = notikit-<projectId>) */
function appForProject(projectId: string, sa: ServiceAccount): App {
  const name = `notikit-${projectId}`;
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

const INVALID_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
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
