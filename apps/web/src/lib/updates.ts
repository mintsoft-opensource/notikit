/**
 * 업데이트 확인 — 고객사 인스턴스가 배포처에 묻는다.
 *
 * 공개 릴리스가 아니라 **인증이 붙은 업데이트 서버**에 묻는다. 라이선스 키가 곧
 * 신원이고, 서버가 이 설치에 줄 버전을 정한다. 클라이언트가 버전을 고르지 않는
 * 이유는, 고르게 두면 만료된 구독이나 건너뛰면 안 되는 버전을 스스로 집어갈 수
 * 있기 때문이다.
 *
 * 응답에는 태그가 아니라 **다이제스트**가 온다. 태그는 나중에 다른 이미지를 가리키게
 * 바뀔 수 있어서, 어제 검증한 것과 오늘 받는 것이 같다고 보장하지 못한다.
 */

import { canReceiveUpdates } from "@/lib/license";

/** 빌드 시각에 package.json 에서 박힌다(next.config.ts) */
export const CURRENT_VERSION = process.env.NOTIKIT_VERSION ?? "0.0.0-dev";

const SERVER = (process.env.NOTIKIT_UPDATE_SERVER ?? "").replace(/\/$/, "");
const LICENSE = process.env.NOTIKIT_LICENSE_KEY ?? "";
const CHANNEL = process.env.NOTIKIT_UPDATE_CHANNEL ?? "stable";
const TIMEOUT_MS = 8_000;
/** 고객사 인스턴스가 매 화면마다 배포처를 때리지 않게 */
const CACHE_MS = 30 * 60_000;

export interface Release {
  version: string;
  /** 레지스트리 경로 — 업데이터가 이걸 그대로 끌어온다 */
  image: string;
  /** sha256:… 태그가 아니라 이것으로 고정해 받는다 */
  digest: string;
  notes: string;
  /** 이 릴리스가 스키마를 바꾸는가. 바꾼다면 되돌릴 수 없으므로 화면에서 경고한다 */
  hasMigrations: boolean;
  /**
   * 이 버전으로 바로 올라올 수 있는 최소 버전. 더 낮으면 중간 버전을 먼저 거쳐야
   * 한다 — 마이그레이션을 건너뛰면 스키마가 어긋난 채로 뜬다.
   */
  minUpgradeFrom: string | null;
  publishedAt: string | null;
}

export type UpdateStatus =
  | "ok"
  /** 업데이트 서버/라이선스가 설정되지 않음 — 수동 운영 중인 설치 */
  | "unconfigured"
  /** 구독 만료·라이선스 무효. 돌고 있는 설치는 그대로 둔다 */
  | "unlicensed"
  /** 네트워크 차단 등 — "최신"과 구분해야 한다 */
  | "unreachable";

export interface UpdateCheck {
  current: string;
  latest: Release | null;
  status: UpdateStatus;
  outdated: boolean;
  /** 건너뛸 수 없는 중간 버전이 있어 바로 올라갈 수 없는 경우 */
  blockedBy: string | null;
}

let cache: { at: number; value: UpdateCheck } | null = null;

/** `v1.2.3` / `1.2.3-rc.1` → [1,2,3] */
function parse(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a 가 b 보다 새로우면 true */
export function isNewer(a: string, b: string): boolean {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i];
  }
  return false;
}

function str(v: unknown, max = 500): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** 배포처 응답도 외부 입력이다 — 모양을 확인하고 쓴다 */
function toRelease(json: unknown): Release | null {
  if (typeof json !== "object" || json === null) return null;
  const r = json as Record<string, unknown>;

  const version = str(r.version, 64).replace(/^v/, "");
  const image = str(r.image, 300);
  const digest = str(r.digest, 100);
  if (!parse(version)) return null;
  // 다이제스트 없이는 무엇을 받는지 고정할 수 없다. 태그만 온 응답은 거부한다.
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) return null;
  // 레지스트리 경로가 임의 문자열이면 업데이터가 아무 데서나 끌어온다
  if (!/^[a-z0-9.\-_/:]+$/i.test(image)) return null;

  return {
    version,
    image,
    digest,
    notes: str(r.notes, 4000),
    hasMigrations: r.hasMigrations === true,
    minUpgradeFrom: parse(str(r.minUpgradeFrom, 64)) ? str(r.minUpgradeFrom, 64).replace(/^v/, "") : null,
    publishedAt: str(r.publishedAt, 40) || null,
  };
}

async function fetchLatest(): Promise<UpdateCheck> {
  const base: UpdateCheck = { current: CURRENT_VERSION, latest: null, status: "ok", outdated: false, blockedBy: null };
  if (!SERVER || !LICENSE) return { ...base, status: "unconfigured" };

  // 라이선스를 **먼저 오프라인으로** 본다. 만료·위조가 분명한데 배포처까지 다녀오는
  // 것은 낭비고, 폐쇄망에서는 그 왕복이 아예 실패해 "연결 불가"로 잘못 보인다.
  if (!canReceiveUpdates()) return { ...base, status: "unlicensed" };

  let res: Response;
  try {
    res = await fetch(`${SERVER}/v1/releases/latest?channel=${encodeURIComponent(CHANNEL)}`, {
      headers: {
        authorization: `Bearer ${LICENSE}`,
        accept: "application/json",
        // 배포처가 어떤 버전에서 올라오는지 알아야 중간 버전을 지정할 수 있다
        "x-notikit-version": CURRENT_VERSION,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    return { ...base, status: "unreachable" };
  }

  // 구독이 끊겼다고 해서 돌고 있는 설치를 멈추지 않는다. 업데이트만 막힌다.
  if (res.status === 401 || res.status === 403) return { ...base, status: "unlicensed" };
  if (!res.ok) return { ...base, status: "unreachable" };
  // 배포처가 줄 릴리스가 없다(채널이 비었거나 이 고객 배포를 멈췄다) — "최신"이지 "연결 불가"가 아니다.
  // 204 는 예전 배포처의 응답이다. 본문이 없어 파싱하면 실패하므로 먼저 거른다.
  if (res.status === 204) return base;

  const json: unknown = await res.json().catch(() => null);
  if (typeof json === "object" && json !== null && "latest" in json && json.latest === null) return base;
  const latest = toRelease(json);
  if (!latest) return { ...base, status: "unreachable" };

  const outdated = isNewer(latest.version, CURRENT_VERSION);
  // 마이그레이션을 건너뛰면 스키마가 어긋난 채로 뜬다. 중간 버전을 먼저 거치게 한다.
  const blockedBy =
    outdated && latest.minUpgradeFrom && isNewer(latest.minUpgradeFrom, CURRENT_VERSION)
      ? latest.minUpgradeFrom
      : null;

  return { current: CURRENT_VERSION, latest, status: "ok", outdated, blockedBy };
}

export async function checkForUpdate(opts?: { force?: boolean }): Promise<UpdateCheck> {
  if (!opts?.force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const value = await fetchLatest();
  // 실패는 캐시하지 않는다 — 일시적 네트워크 오류로 30분간 "모름"이 굳으면 안 된다
  if (value.status === "ok" || value.status === "unconfigured") cache = { at: Date.now(), value };
  return value;
}
