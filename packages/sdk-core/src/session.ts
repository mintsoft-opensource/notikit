import { NotikitClient } from "./index";
import { logIdFromPayload, type Platform } from "./types";

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
  /**
   * 클릭 당시 로그인해 있던 유저. 서버는 flush 시점의 바인딩으로 유저를 해석하므로,
   * 그 사이 계정이 바뀌었으면 이 클릭은 다음 사람에게 귀속된다 — 그래서 폐기한다.
   * 비로그인 상태의 클릭은 undefined.
   */
  externalId?: string;
}

/** 오프라인 로그아웃으로 실패한 언바인딩 — 재시도할 때까지 서버 바인딩이 남는다 */
interface PendingUnbind {
  token: string;
  identityHash?: string;
  at: number;
}

const USER_KEY = "notikit.user";
const QUEUE_KEY = "notikit.clickQueue";
const QUEUE_MAX = 50;
const UNBIND_KEY = "notikit.pendingUnbind";
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
 * JSON 문법만 통과한 값이 배열이라는 보장은 없다. 저장소에 `{}` 가 들어 있으면
 * 파싱은 성공하고 이후 `.filter` 에서 터져 큐가 영구히 멈춘다.
 */
function parseQueue(raw: string | null): QueuedClick[] {
  const v = safeParse<unknown>(raw);
  if (!Array.isArray(v)) return [];
  return v.filter(
    (c): c is QueuedClick =>
      !!c && typeof c === "object" &&
      typeof (c as QueuedClick).logId === "string" &&
      typeof (c as QueuedClick).token === "string" &&
      typeof (c as QueuedClick).at === "number"
  );
}

/**
 * 로그인 유저를 영속 저장하고, 푸시 클릭을 보고하는 세션 계층.
 *
 * 저장한 유저를 **클릭에 실어 보내지 않는다**. 서버가 신뢰하는 것은 디바이스 바인딩이고,
 * 클라이언트가 주장하는 external_id 를 믿으면 등록 시 identity_hash 로 막아둔 사칭이
 * 클릭 경로로 다시 열린다. 저장한 유저는 **바인딩을 최신으로 유지**하는 데만 쓴다.
 */
export class NotikitSession {
  /** 저장소 read-modify-write 직렬화 — 동시 클릭 두 건이 서로를 덮어쓰지 않게 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: NotikitClient,
    private readonly storage: NotikitStorage,
    private readonly platform: Platform
  ) {}

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async getUser(): Promise<StoredUser | null> {
    return safeParse<StoredUser>(await this.storage.getItem(USER_KEY));
  }

  /**
   * 로그인 — 유저를 저장하고 디바이스를 그 유저에 바인딩한다.
   * 이후 이 기기의 클릭은 서버가 이 유저로 귀속한다.
   */
  async login(user: StoredUser, token: string): Promise<void> {
    // 새 바인딩이 덮어쓰므로 밀린 언바인딩은 의미가 없다
    await this.storage.removeItem(UNBIND_KEY);
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
    const user = await this.getUser();
    await this.storage.removeItem(USER_KEY);
    // 이전 세션의 밀린 클릭은 버린다 — 지금 보내면 다음 로그인 유저에게 붙는다
    await this.serialize(async () => {
      const rest = parseQueue(await this.storage.getItem(QUEUE_KEY)).filter((c) => c.token !== token);
      if (rest.length > 0) await this.storage.setItem(QUEUE_KEY, JSON.stringify(rest));
      else await this.storage.removeItem(QUEUE_KEY);
    });

    try {
      await this.client.unbindDevice(token, this.platform, user?.identityHash);
    } catch (e) {
      // 로그아웃은 오프라인에서 가장 자주 일어난다. 여기서 포기하면 서버 바인딩이
      // 이전 유저로 남아 다음 사람의 클릭이 그 유저에게 붙는다 — 재시도용으로 남긴다.
      await this.storage.setItem(
        UNBIND_KEY,
        JSON.stringify({ token, identityHash: user?.identityHash, at: Date.now() } satisfies PendingUnbind)
      );
      throw e;
    }
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
      const user = await this.getUser();
      await this.enqueue({ logId, token, destination, at: Date.now(), externalId: user?.externalId });
      return false;
    }
  }

  /**
   * 앱 열림 보고. 실패해도 재시도하지 않는다 — 접속 통계는 하루 단위 집계라
   * 한 번 놓쳐도 그 날의 DAU 는 다음 열림에서 회복된다.
   */
  async trackOpen(token: string): Promise<boolean> {
    try {
      await this.client.ping(token);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 알림 탭 처리 — **푸시 페이로드를 그대로 넘기면 된다.**
   *
   * 플랫폼마다 탭 이벤트를 받는 지점이 달라(Android 는 Intent extras, iOS 는
   * userInfo, 웹은 notificationclick) SDK 가 그 자리를 대신 잡을 수 없다. 대신
   * "페이로드에서 발송 id 를 꺼내 클릭을 보고한다"는 공통 부분을 여기서 처리한다.
   *
   * notikit 이 보낸 알림이 아니면(발송 id 없음) 아무 것도 하지 않고 false 를 준다 —
   * 다른 경로로 온 알림까지 클릭으로 세면 클릭률이 부풀려진다.
   */
  async handleNotificationOpen(payload: unknown, token: string, destination?: string): Promise<boolean> {
    const logId = logIdFromPayload(payload);
    if (!logId) return false;
    return this.reportClick(logId, token, destination);
  }

  /** 밀린 클릭 재전송 — SDK 초기화 직후·앱 포그라운드 진입 시 호출 */
  async flush(): Promise<number> {
    await this.retryPendingUnbind();

    const queue = await this.serialize(async () => parseQueue(await this.storage.getItem(QUEUE_KEY)));
    if (queue.length === 0) return 0;

    const current = (await this.getUser())?.externalId;
    const done = new Set<string>();
    let sent = 0;

    for (const c of queue) {
      const key = `${c.logId}|${c.token}`;
      // 만료됐거나, 클릭 당시 유저와 지금 유저가 다르면 보내지 않고 버린다
      if (Date.now() - c.at >= QUEUE_TTL_MS || c.externalId !== current) {
        done.add(key);
        continue;
      }
      try {
        await this.client.reportClick({ logId: c.logId, token: c.token, destination: c.destination });
        done.add(key);
        sent++;
      } catch (e) {
        // 4xx 는 재시도해도 결과가 같다(토큰 교체로 404 등). 7일간 두드리지 않고 버린다.
        const status = (e as { status?: number })?.status;
        if (typeof status === "number" && status >= 400 && status < 500 && status !== 429) done.add(key);
      }
    }

    // 전송 중 새로 쌓인 항목을 지우지 않도록, 스냅샷을 통째로 덮어쓰지 않고
    // **처리한 것만** 현재 큐에서 제거한다
    await this.serialize(async () => {
      const current = parseQueue(await this.storage.getItem(QUEUE_KEY));
      const rest = current.filter((c) => !done.has(`${c.logId}|${c.token}`));
      if (rest.length > 0) await this.storage.setItem(QUEUE_KEY, JSON.stringify(rest));
      else await this.storage.removeItem(QUEUE_KEY);
    });
    return sent;
  }

  /** 실패해 남아 있던 언바인딩 재시도 — 성공할 때까지 서버 바인딩이 이전 유저로 남는다 */
  private async retryPendingUnbind(): Promise<void> {
    const pending = safeParse<PendingUnbind>(await this.storage.getItem(UNBIND_KEY));
    if (!pending?.token) return;
    try {
      await this.client.unbindDevice(pending.token, this.platform, pending.identityHash);
      await this.storage.removeItem(UNBIND_KEY);
    } catch {
      /* 다음 flush 에서 재시도 */
    }
  }

  private enqueue(click: QueuedClick): Promise<void> {
    return this.serialize(async () => {
      const queue = parseQueue(await this.storage.getItem(QUEUE_KEY));
      // 같은 발송의 중복 클릭은 서버에서도 유니크로 걸리므로 큐 단계에서 미리 접는다
      if (queue.some((c) => c.logId === click.logId && c.token === click.token)) return;
      queue.push(click);
      await this.storage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX)));
    });
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
