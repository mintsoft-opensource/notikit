import { createHash } from "node:crypto";
import { getApps, initializeApp, deleteApp, cert, type App } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import type { ServiceAccount } from "./firebase-credentials";

export interface FcmMessage {
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  /** 발송 로그 id — 클릭 회신이 어떤 발송의 것인지 매칭하는 유일한 키 */
  logId?: string;
  data?: Record<string, unknown>;
}

export interface FcmResult {
  success: number;
  failure: number;
  invalidTokens: string[];
  /** FCM 이 받아들인 토큰 — 이것만 "실재하는 기기"로 신뢰할 수 있다 */
  validTokens: string[];
}

/** 크레덴셜 지문 — 회전 감지용 */
function credFingerprint(sa: ServiceAccount): string {
  return createHash("sha256").update(`${sa.client_email}:${sa.private_key}`).digest("hex").slice(0, 12);
}

// projectId → { fp, app } : O(1) 조회 + 회전 시 이전 App 제거(누적 방지)
const appCache = new Map<string, { fp: string; app: App }>();

function appForProject(projectId: string, sa: ServiceAccount): App {
  const fp = credFingerprint(sa);
  const cached = appCache.get(projectId);
  if (cached && cached.fp === fp) return cached.app;
  if (cached) void deleteApp(cached.app).catch(() => {}); // 회전: 이전 App 정리

  const name = `notikit-${projectId}-${fp}`;
  const app =
    getApps().find((a) => a.name === name) ??
    initializeApp(
      { credential: cert({ projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key }) },
      name
    );
  appCache.set(projectId, { fp, app });
  return app;
}

function buildData(msg: FcmMessage): Record<string, string> {
  const data: Record<string, string> = {};
  if (msg.deepLink) data.deep_link = msg.deepLink;
  for (const [k, v] of Object.entries(msg.data ?? {})) {
    data[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  // 커스텀 data 가 덮어쓰지 못하도록 마지막에 — 클릭 추적의 무결성이 우선
  if (msg.logId) data.notikit_log_id = msg.logId;
  return data;
}

// 토큰 자체가 무효인 경우만 (payload 오류인 invalid-argument 는 제외 — 정상 토큰 오삭제 방지)
const INVALID_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

/**
 * 최대 500개 토큰에 멀티캐스트 전송 → 성공/실패/무효토큰 반환.
 *
 * dryRun 이면 FCM 이 요청과 토큰을 **검증만 하고 실제로 배달하지 않는다**(validate_only).
 * 유저에게 아무것도 보이지 않으므로 죽은 토큰 청소에 쓸 수 있다.
 */
export async function sendToTokens(
  projectId: string,
  sa: ServiceAccount,
  tokens: string[],
  msg: FcmMessage,
  dryRun = false,
  /**
   * 알림 표시를 클라이언트에 맡긴다(notification 페이로드 생략).
   *
   * 웹에 필요하다. `notification` 이 실려 있으면 Firebase 워커가 **알림을 자동으로
   * 띄운 뒤** onBackgroundMessage 도 부른다 — 우리 워커가 하나 더 띄워 알림이 두 번
   * 뜨고, 자동 표시된 쪽은 Firebase 가 클릭 전파를 막아 클릭 추적도 안 된다.
   * data-only 면 자동 표시가 꺼져 우리 워커가 표시·클릭추적을 온전히 담당한다.
   */
  dataOnly = false
): Promise<FcmResult> {
  if (tokens.length === 0) return { success: 0, failure: 0, invalidTokens: [], validTokens: [] };

  const data = buildData(msg);
  if (dataOnly) {
    // 워커가 알림을 그리려면 제목·본문도 data 로 실어야 한다
    data.title = msg.title;
    data.body = msg.body;
    if (msg.imageUrl) data.icon = msg.imageUrl;
  }

  const messaging = getMessaging(appForProject(projectId, sa));
  const res = await messaging.sendEachForMulticast({
    tokens,
    ...(dataOnly ? {} : { notification: { title: msg.title, body: msg.body, imageUrl: msg.imageUrl } }),
    data,
  }, dryRun);

  const invalidTokens: string[] = [];
  const validTokens: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) validTokens.push(tokens[i]);
    else if (r.error && INVALID_CODES.has(r.error.code)) invalidTokens.push(tokens[i]);
    // 나머지(쿼터·일시 장애)는 판정 불가 — 어느 쪽에도 넣지 않는다
  });

  return { success: res.successCount, failure: res.failureCount, invalidTokens, validTokens };
}
