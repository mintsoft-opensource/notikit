/**
 * 릴리스 카탈로그 판정 — 버전 비교, 이 고객이 받을 릴리스, 건너뛰는 구간의 마이그레이션 유무.
 * 서버(index.mjs)와 분리해 둔 이유는 테스트다. 여기엔 I/O 가 없다.
 */

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 등록 버전. 이 값이 `releases/<버전>.json` 파일 이름이 되므로 끝까지 고정한다(경로 조작 차단). */
const PUBLISHABLE = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

export function semver(v) {
  const m = SEMVER.exec(String(v ?? "").trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

export function isPublishableVersion(v) {
  return typeof v === "string" && PUBLISHABLE.test(v);
}

function comparePre(a, b) {
  // 프리릴리스가 없는 쪽(정식)이 더 높다 — 1.3.0-beta.1 < 1.3.0
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    const x = /^\d+$/.test(a[i]) ? Number(a[i]) : null;
    const y = /^\d+$/.test(b[i]) ? Number(b[i]) : null;
    if (x !== null && y !== null) {
      if (x !== y) return x - y;
    } else if (x !== null) {
      return -1;
    } else if (y !== null) {
      return 1;
    } else if (a[i] !== b[i]) {
      return a[i] < b[i] ? -1 : 1;
    }
  }
  return 0;
}

/**
 * semver 우선순위 비교. 예전엔 프리릴리스를 무시해 beta.1 과 beta.2 가 같게 보였고,
 * beta 채널의 "최신"이 파일 읽는 순서에 따라 달라졌다.
 */
export function cmp(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  return comparePre(x.pre, y.pre);
}

function channelOf(r) {
  return r.channel ?? "stable";
}

/**
 * 이 고객에게 줄 최신 릴리스.
 *
 * 고객별 `pin` 이 있으면 그 버전에 묶는다 — 검증이 끝난 버전에 세워 두거나, 사고가
 * 난 릴리스에서 특정 고객만 잡아 두기 위해서다. 그런 수단이 없으면 문제가 생겼을 때
 * 할 수 있는 일이 "모두에게 배포를 멈추는 것"뿐이다.
 *
 * `catalog.releases` 는 cmp 로 정렬돼 있어야 한다.
 */
export function resolve(catalog, license, requestedChannel) {
  const override = catalog.customers[license.customerId] ?? {};
  if (override.blocked) return null;

  /**
   * 채널은 **우리가** 정한다. 순서가 중요하다.
   *
   * 요청 채널을 라이선스보다 앞에 두면 고객사가 `.env` 한 줄로 채널을 바꾼다 —
   * stable 계약 고객이 beta 를 끌어가는 길이 열린다. 버전을 못 고르게 만든 이유와
   * 같은 이유로 채널도 못 고르게 한다.
   *
   * 요청 채널은 라이선스에 채널이 없을 때의 폴백으로만 쓴다(구버전 라이선스 호환).
   */
  const channel = override.channel ?? license.channel ?? requestedChannel ?? "stable";
  const eligible = catalog.releases.filter((r) => channelOf(r) === channel && !r.yanked);
  if (eligible.length === 0) return null;

  if (override.pin) return eligible.find((r) => cmp(r.version, override.pin) === 0) ?? null;
  return eligible[eligible.length - 1];
}

/**
 * 설치본(`installed`)에서 `target` 으로 올라갈 때 스키마가 바뀌는가.
 *
 * 매니페스트의 `hasMigrations` 는 **바로 이전 태그**와의 차이다. 1.0 → 1.3 처럼 중간을
 * 건너뛰면 1.3 의 플래그만 보고는 1.1 의 마이그레이션을 모른다 — 그 날 백업 없이 스키마가
 * 바뀐다. 그래서 (installed, target] 구간의 같은 채널 릴리스를 모두 OR 한다. yanked 도
 * 넣는다: 내려간 릴리스의 스키마 변경은 다음 릴리스에 그대로 실려 있다.
 *
 * 설치 버전을 모르면(헤더 없음·해석 불가) true — 모르면 있다고 보고 백업을 뜬다.
 * 틀렸을 때의 비용이 한쪽으로만 크다.
 */
export function hasMigrationsSince(releases, target, installed) {
  if (target.hasMigrations === true) return true;
  if (!semver(installed)) return true;
  const channel = channelOf(target);
  return releases.some(
    (r) =>
      channelOf(r) === channel &&
      r.hasMigrations === true &&
      cmp(r.version, installed) > 0 &&
      cmp(r.version, target.version) <= 0
  );
}
