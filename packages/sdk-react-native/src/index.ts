import { NotikitClient, type NotikitConfig } from "@notikit/core";

export interface NotikitRNConfig extends Omit<NotikitConfig, "apiSecret"> {
  /** user id 바인딩 시 identity 검증 해시(고객 서버 계산) */
  identityHash?: string;
}

/**
 * Notikit React Native SDK.
 * FCM 토큰 획득은 호스트 앱의 @react-native-firebase/messaging 이 담당하고,
 * 이 SDK 는 그 토큰을 서버에 등록/식별/구독한다 (api-key 만 — secret 미포함).
 */
export class NotikitReactNative {
  private readonly client: NotikitClient;
  private readonly identityHash?: string;

  constructor(config: NotikitRNConfig) {
    this.client = new NotikitClient(config);
    this.identityHash = config.identityHash;
  }

  /** FCM 토큰 등록 (플랫폼: android|ios). userId 는 고객 서비스의 유저 id — 서버에 user_id 로 보낸다 */
  register(fcmToken: string, platform: "android" | "ios", userId?: string) {
    return this.client.registerDevice({
      token: fcmToken,
      platform,
      userId,
      identityHash: userId ? this.identityHash : undefined,
    });
  }

  /** 유저 식별. userId 는 고객 서비스의 유저 id, name 은 치환 변수 {{name}} 과 콘솔 표시에 쓰인다 */
  identify(userId: string, attributes?: Record<string, unknown>, name?: string | null) {
    return this.client.identify({ userId, identityHash: this.identityHash, attributes, name });
  }

  subscribe(topic: string, fcmToken: string) {
    return this.client.subscribe(topic, fcmToken);
  }

  /** 알림 설정 토글을 끄는 경로 — 이게 없으면 켠 토픽을 앱에서 끌 수 없다 */
  unsubscribe(topic: string, fcmToken: string) {
    return this.client.unsubscribe(topic, fcmToken);
  }

  /**
   * 전환 보고 — 직전 24시간 안에 이 기기가 클릭한 발송의 성과로 귀속된다.
   * 클릭이 없으면 `attributed: false` 로 끝난다(오류가 아니다).
   */
  trackConversion(fcmToken: string, name: string, valueCents?: number) {
    return this.client.trackConversion({ token: fcmToken, name, valueCents });
  }

  get core(): NotikitClient {
    return this.client;
  }
}

export * from "@notikit/core";
