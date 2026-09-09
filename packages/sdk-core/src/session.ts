import { NotikitClient } from "./index";
import type { Platform } from "./types";

/**
 * 플랫폼별 영속 저장소. 푸시 클릭은 앱이 죽은 상태에서 콜드 스타트로 들어오므로
 * 메모리가 아니라 프로세스 재시작을 넘기는 저장소여야 한다.
 * web: localStorage · RN: AsyncStorage · Android: SharedPreferences · iOS: UserDefaults
 */
export interface NotikitStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** 로그인 시 저장해두는 유저 — 클릭 시점에 바인딩이 최신인지 보장하는 데 쓴다 */
export interface StoredUser {
  externalId: string;
  identityHash?: string;
}

interface QueuedClick {
  logId: string;
  token: string;
  destination?: string;
  /** 최초 시도 시각(ms) — 오래된 클릭은 버려서 큐가 무한히 자라지 않게 한다 */
  at: number;
}

const USER_KEY = "notikit.user";
const QUEUE_KEY = "notikit.clickQueue";
const QUEUE_MAX = 50;
const QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safeParse<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null; // 손상된 값은 조용히 버린다 — 저장소 파손이 SDK 를 죽이면 안 된다
  }
}

/**
 * 로그인 유저를 영속 저장하고, 푸시 클릭을 보고하는 세션 계층.
 *
 * 저장한 유저를 **클릭에 실어 보내지 않는다**. 서버가 신뢰하는 것은 디바이스 바인딩이고,
 * 클라이언트가 주장하는 external_id 를 믿으면 등록 시 identity_hash 로 막아둔 사칭이
 * 클릭 경로로 다시 열린다. 저장한 유저는 **바인딩을 최신으로 유지**하는 데만 쓴다.
 */
export class NotikitSession {
  constructor(
    private readonly client: NotikitClient,
    private readonly storage: NotikitStorage,
    private readonly platform: Platform
  ) {}

  async getUser(): Promise<StoredUser | null> {
    return safeParse<StoredUser>(await this.storage.getItem(USER_KEY));
  }

  /**
   * 로그인 — 유저를 저장하고 디바이스를 그 유저에 바인딩한다.
   * 이후 이 기기의 클릭은 서버가 이 유저로 귀속한다.
   */
  async login(user: StoredUser, token: string): Promise<void> {
    await this.storage.setItem(USER_KEY, JSON.stringify(user));
    await this.client.registerDevice({
      token,
      platform: this.platform,
      externalId: user.externalId,
      identityHash: user.identityHash,
    });
  }

  /**
   * 로그아웃 — 저장된 유저를 지우고 서버 바인딩도 해제한다.
   * 해제를 빠뜨리면 공용 기기에서 다음 사람의 클릭이 이전 계정에 붙는다.
   */
  async logout(token: string): Promise<void> {
    await this.storage.removeItem(USER_KEY);
    await this.client.unbindDevice(token, this.platform);
  }

  /**
   * 푸시 클릭 보고. 실패하면 큐에 넣어 다음 flush 때 재시도한다
   * (콜드 스타트 직후·오프라인에서 클릭이 조용히 유실되면 클릭률이 낮게 잡힌다).
   */
  async reportClick(logId: string, token: string, destination?: string): Promise<boolean> {
    try {
      await this.client.reportClick({ logId, token, destination });
      return true;
    } catch {
      await this.enqueue({ logId, token, destination, at: Date.now() });
      return false;
    }
  }

  /** 밀린 클릭 재전송 — SDK 초기화 직후·앱 포그라운드 진입 시 호출 */
  async flush(): Promise<number> {
    const queue = safeParse<QueuedClick[]>(await this.storage.getItem(QUEUE_KEY)) ?? [];
    if (queue.length === 0) return 0;

    const fresh = queue.filter((c) => Date.now() - c.at < QUEUE_TTL_MS);
    const failed: QueuedClick[] = [];
    let sent = 0;

    for (const c of fresh) {
      try {
        await this.client.reportClick({ logId: c.logId, token: c.token, destination: c.destination });
        sent++;
      } catch {
        failed.push(c);
      }
    }

    if (failed.length > 0) await this.storage.setItem(QUEUE_KEY, JSON.stringify(failed));
    else await this.storage.removeItem(QUEUE_KEY);
    return sent;
  }

  private async enqueue(click: QueuedClick): Promise<void> {
    const queue = safeParse<QueuedClick[]>(await this.storage.getItem(QUEUE_KEY)) ?? [];
    // 같은 발송의 중복 클릭은 서버에서도 유니크로 걸리므로 큐 단계에서 미리 접는다
    if (queue.some((c) => c.logId === click.logId && c.token === click.token)) return;
    queue.push(click);
    await this.storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX)));
  }
}

/** 브라우저/RN 등 동기 key-value 저장소를 NotikitStorage 로 감싼다 */
export function memoryStorage(): NotikitStorage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}
