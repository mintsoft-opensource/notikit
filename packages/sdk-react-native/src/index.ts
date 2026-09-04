import { NotikitClient, type NotikitConfig } from "@notikit/core";

export interface NotikitRNConfig extends Omit<NotikitConfig, "apiSecret"> {
  /** external_id 바인딩 시 identity 검증 해시(고객 서버 계산) */
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

  /** FCM 토큰 등록 (플랫폼: android|ios) */
  register(fcmToken: string, platform: "android" | "ios", externalId?: string) {
    return this.client.registerDevice({
      token: fcmToken,
      platform,
      externalId,
      identityHash: externalId ? this.identityHash : undefined,
    });
  }

  identify(externalId: string, attributes?: Record<string, unknown>) {
    return this.client.identify({ externalId, identityHash: this.identityHash, attributes });
  }

  subscribe(topic: string, fcmToken: string) {
    return this.client.subscribe(topic, fcmToken);
  }

  get core(): NotikitClient {
    return this.client;
  }
}

export * from "@notikit/core";
