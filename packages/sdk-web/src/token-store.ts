/**
 * 서비스워커가 클릭을 보고할 때 쓸 FCM 토큰 저장소.
 *
 * 워커는 `getToken()` 을 부를 수 없다 — firebase/messaging 의 getToken 은 window 전용이고
 * 워커 빌드(`firebase/messaging/sw`)에는 없다. 그래서 메인 스레드가 등록 직후 토큰을
 * IndexedDB 에 남기고, 워커는 notificationclick 에서 그 값을 읽는다.
 *
 * localStorage 를 못 쓰는 이유: 서비스워커 스코프에는 존재하지 않는다.
 */
export const NOTIKIT_DB = "notikit";
export const NOTIKIT_STORE = "kv";
export const NOTIKIT_TOKEN_KEY = "fcmToken";

/**
 * 저장 키를 프로젝트로 나눈다. IndexedDB 는 오리진 단위라, 같은 오리진에서 두 앱이
 * (예: /a/ 와 /b/) 각자 워커를 띄우면 단일 키를 서로 덮어쓴다. 그러면 A 의 알림을
 * 눌렀을 때 B 의 토큰이 A 의 api-key 로 전송되어 클릭이 404 로 사라진다.
 */
export function tokenKey(apiKey: string): string {
  return `${NOTIKIT_TOKEN_KEY}:${apiKey}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(NOTIKIT_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(NOTIKIT_STORE)) {
        req.result.createObjectStore(NOTIKIT_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveToken(token: string, apiKey: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(NOTIKIT_STORE, "readwrite");
      tx.objectStore(NOTIKIT_STORE).put(token, tokenKey(apiKey));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function readToken(apiKey: string): Promise<string | null> {
  const db = await open();
  try {
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(NOTIKIT_STORE, "readonly");
      const req = tx.objectStore(NOTIKIT_STORE).get(tokenKey(apiKey));
      req.onsuccess = () => resolve((req.result as string | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
