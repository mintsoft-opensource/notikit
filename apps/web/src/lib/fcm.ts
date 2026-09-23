import { createHash } from "node:crypto";
import { getApps, initializeApp, deleteApp, cert, type App } from "firebase-admin/app";
import {
  getMessaging,
  type AndroidConfig,
  type ApnsConfig,
  type Aps,
  type BatchResponse,
  type Message,
  type MulticastMessage,
} from "firebase-admin/messaging";
import type { ServiceAccount } from "./firebase-credentials";

/** 알림 액션 버튼 — 페이로드에는 `data.actions`(JSON 문자열)로 실리고 앱 SDK 가 읽어 그린다 */
export interface PushAction {
  /** 앱이 어떤 버튼을 눌렀는지 구분하는 값 */
  id: string;
  title: string;
  /** 이 버튼으로 이동할 곳. 없으면 발송의 deep_link 를 쓴다 */
  deep_link?: string;
}

/**
 * 발송 한 건의 알림 옵션. 플랫폼마다 자리가 달라 여기서 한 번만 정의하고
 * `buildMulticast` 가 Android·APNs·웹(data) 로 나눠 싣는다.
 */
export interface PushOptions {
  /** 알림음 파일명 또는 "default" */
  sound?: string;
  /** iOS 앱 아이콘 배지 수 */
  badge?: number;
  /** 같은 키의 이전 알림을 덮어쓴다 (Android collapse_key / APNs apns-collapse-id) */
  collapse_key?: string;
  android_channel_id?: string;
  ios_thread_id?: string;
  /** 배달 유효기간(초). 0 이면 지금 못 받는 기기에는 버린다. 최대 28일. */
  ttl_seconds?: number;
  priority?: "normal" | "high";
  /** 무음 푸시 — 알림을 그리지 않고 data 만 보낸다(iOS 는 content-available 로 앱을 깨운다) */
  silent?: boolean;
  /** 액션 버튼(최대 3개) */
  actions?: PushAction[];
}

export interface FcmMessage {
  title: string;
  body: string;
  imageUrl?: string;
  deepLink?: string;
  /** 발송 로그 id — 클릭 회신이 어떤 발송의 것인지 매칭하는 유일한 키 */
  logId?: string;
  data?: Record<string, unknown>;
  options?: PushOptions;
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
  // 커스텀 data 가 덮어쓰지 못하도록 마지막에 — 클릭 추적·액션 버튼의 무결성이 우선
  const actions = msg.options?.actions;
  if (actions?.length) data.actions = JSON.stringify(actions);
  if (msg.logId) data.notikit_log_id = msg.logId;
  return data;
}

/**
 * APNs 유효기간 헤더 값(절대 epoch 초). 0 은 "지금 못 받으면 버린다"라는 약속된 값이라 그대로 쓴다 —
 * 현재 시각을 더하면 "즉시 만료"가 "1초 뒤 만료"가 되어 뜻이 달라진다.
 */
function apnsExpiration(ttlSeconds: number): string {
  return ttlSeconds === 0 ? "0" : String(Math.floor(Date.now() / 1000) + ttlSeconds);
}

/** 옵션 → Android 설정. 실을 게 없으면 undefined(빈 블록을 넣지 않는다). */
function androidConfig(o: PushOptions, quiet: boolean): AndroidConfig | undefined {
  // quiet(웹 data-only·무음)에 notification 을 실으면 FCM 이 알림 메시지로 바꿔 기기가 직접 그린다
  const notification = quiet
    ? {}
    : {
        ...(o.android_channel_id ? { channelId: o.android_channel_id } : {}),
        ...(o.sound ? { sound: o.sound } : {}),
      };
  const cfg: AndroidConfig = {
    ...(o.ttl_seconds !== undefined ? { ttl: o.ttl_seconds * 1000 } : {}),
    ...(o.priority ? { priority: o.priority } : {}),
    ...(o.collapse_key ? { collapseKey: o.collapse_key } : {}),
    ...(Object.keys(notification).length ? { notification } : {}),
  };
  return Object.keys(cfg).length ? cfg : undefined;
}

/** 옵션 → APNs 설정. `image` 는 알림을 그리는 발송에서만 넘어온다. */
function apnsConfig(o: PushOptions, silent: boolean, image: string | undefined): ApnsConfig | undefined {
  const headers: Record<string, string> = {
    ...(o.collapse_key ? { "apns-collapse-id": o.collapse_key } : {}),
    ...(o.ttl_seconds !== undefined ? { "apns-expiration": apnsExpiration(o.ttl_seconds) } : {}),
    // 무음·낮은 우선순위는 5 로 — 무음 푸시를 10 으로 보내면 APNs 가 거절한다
    ...(silent || o.priority === "normal" ? { "apns-priority": "5" } : {}),
  };
  const aps: Aps = {
    ...(silent ? { contentAvailable: true } : {}),
    ...(o.sound ? { sound: o.sound } : {}),
    ...(o.badge !== undefined ? { badge: o.badge } : {}),
    ...(o.ios_thread_id ? { threadId: o.ios_thread_id } : {}),
    ...(image ? { mutableContent: true } : {}),
  };
  const cfg: ApnsConfig = {
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(Object.keys(aps).length ? { payload: { aps } } : {}),
    ...(image ? { fcmOptions: { imageUrl: image } } : {}),
  };
  return Object.keys(cfg).length ? cfg : undefined;
}

/**
 * 멀티캐스트 본문(토큰 제외). 순수 함수 — 페이로드 모양을 단위 테스트로 고정한다.
 *
 * 이미지: 네이티브는 notification.imageUrl(Android 는 이것만으로 그린다). iOS 는 그것만으로는
 * 그리지 않아 `mutable-content: 1` 로 앱의 Notification Service Extension 을 깨우고
 * fcm_options.image 를 넘긴다(firebase-admin 이 mutableContent 를 그 키로 바꿔 싣는다).
 * 웹(data-only)은 워커가 그리므로 data.image 로 — icon 은 앱 아이콘 자리라 따로 둔다.
 *
 * 무음 푸시(`options.silent`)는 플랫폼과 무관하게 알림을 그리지 않는다 — 제목·본문도 싣지 않는다.
 */
export function buildMulticast(msg: FcmMessage, dataOnly: boolean): Omit<MulticastMessage, "tokens"> {
  const o = msg.options ?? {};
  const silent = o.silent === true;
  const quiet = silent || dataOnly;
  const image = msg.imageUrl;
  const data = buildData(msg);
  if (quiet && !silent) {
    // 워커가 알림을 그리려면 제목·본문도 data 로 실어야 한다
    data.title = msg.title;
    data.body = msg.body;
    if (image) data.image = image;
  }
  const android = androidConfig(o, quiet);
  const apns = apnsConfig(o, silent, quiet ? undefined : image);
  return {
    ...(quiet ? {} : { notification: { title: msg.title, body: msg.body, ...(image ? { imageUrl: image } : {}) } }),
    ...(android ? { android } : {}),
    ...(apns ? { apns } : {}),
    data,
  };
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

  const messaging = getMessaging(appForProject(projectId, sa));
  const res = await messaging.sendEachForMulticast({ tokens, ...buildMulticast(msg, dataOnly) }, dryRun);
  return classifyResponses(tokens, res);
}

/** 응답 → 성공/실패/무효 토큰 (순수 함수). 응답 순서는 요청 토큰 순서와 같다. */
export function classifyResponses(tokens: string[], res: Pick<BatchResponse, "responses" | "successCount" | "failureCount">): FcmResult {
  const invalidTokens: string[] = [];
  const validTokens: string[] = [];
  res.responses.forEach((r, i) => {
    if (r.success) validTokens.push(tokens[i]);
    else if (r.error && INVALID_CODES.has(r.error.code)) invalidTokens.push(tokens[i]);
    // 나머지(쿼터·일시 장애)는 판정 불가 — 어느 쪽에도 넣지 않는다
  });
  return { success: res.successCount, failure: res.failureCount, invalidTokens, validTokens };
}

/** FCM sendEach 한 번의 최대 메시지 수 */
export const SEND_EACH_LIMIT = 500;

export type TokenMessage = { token: string; msg: FcmMessage; dataOnly: boolean };

/**
 * 토큰마다 내용이 다른 발송(개인화) — 메시지 배열을 sendEach 한 번으로(최대 500).
 *
 * 내용이 같은 토큰끼리 멀티캐스트로 묶으면 치환 결과가 사람마다 다를 때 사실상 1명짜리
 * 멀티캐스트가 사람 수만큼 생겨 HTTP 호출이 폭증한다.
 */
export async function sendEachToTokens(
  projectId: string,
  sa: ServiceAccount,
  items: TokenMessage[],
  dryRun = false
): Promise<FcmResult> {
  if (items.length === 0) return { success: 0, failure: 0, invalidTokens: [], validTokens: [] };
  if (items.length > SEND_EACH_LIMIT) throw new Error(`sendEach accepts at most ${SEND_EACH_LIMIT} messages`);
  const messages: Message[] = items.map((it) => ({ token: it.token, ...buildMulticast(it.msg, it.dataOnly) }));
  const res = await getMessaging(appForProject(projectId, sa)).sendEach(messages, dryRun);
  return classifyResponses(items.map((it) => it.token), res);
}
