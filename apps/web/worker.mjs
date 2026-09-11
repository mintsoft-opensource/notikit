/**
 * Notikit worker — 주기적으로 각 프로젝트의 큐/저니/웹훅을 처리한다.
 * 웹 서비스의 admin 엔드포인트를 폴링하는 경량 프로세스(별도 빌드 불필요).
 *
 * env: WORKER_BASE_URL(기본 http://localhost:3000), ADMIN_TOKEN, WORKER_INTERVAL_MS(기본 10000)
 */
const BASE = (process.env.WORKER_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;

/** 숫자 env — 빈 문자열/쓰레기값이 조용히 0 이나 NaN 이 되지 않게. */
function numEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(`[worker] ${name}="${raw}" is invalid; using ${fallback}`);
    return fallback;
  }
  return n;
}

const INTERVAL = numEnv("WORKER_INTERVAL_MS", 10_000, { min: 1000 });
/** 프로젝트 목록 페이지 상한(페이지당 200) — 커서가 안 끝나도 tick 이 갇히지 않게 */
const MAX_PROJECT_PAGES = 50;

// 죽은 토큰 야간 스윕. FCM dry-run 이라 배달되지 않으므로 유저를 깨우지 않는다 —
// 새벽에 도는 이유는 방해 회피가 아니라 부하와 FCM 할당량 때문이다.
// 서버 로컬시각이 아니라 UTC 기준: 프로젝트 방해금지 시간대도 UTC 로 저장한다.
const TOKEN_CHECK_ENABLED = process.env.TOKEN_CHECK_ENABLED !== "false";
const TOKEN_CHECK_HOUR_UTC = numEnv("TOKEN_CHECK_HOUR_UTC", 0, { min: 0, max: 23 });
const TOKEN_CHECK_MIN_INTERVAL_HOURS = numEnv("TOKEN_CHECK_MIN_INTERVAL_HOURS", 20, { min: 0, max: 720 });
// partial 이어받기 상한 — 무한 루프로 tick 을 붙잡지 않게. 남으면 다음 창에서 이어진다.
const TOKEN_CHECK_MAX_ROUNDS = numEnv("TOKEN_CHECK_MAX_ROUNDS", 20, { min: 1 });

if (!ADMIN) {
  console.error("[worker] ADMIN_TOKEN is required");
  process.exit(1);
}

const admin = { "x-admin-token": ADMIN, "content-type": "application/json" };

async function post(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { method: "POST", headers: admin, body: "{}" });
    return await res.json().catch(() => null);
  } catch {
    return null; // 다음 tick 에서 재시도
  }
}

/** 프로젝트 id → 0-59 분. 전 테넌트가 정각에 한꺼번에 몰려 FCM/DB 를 때리지 않게 분산한다. */
function staggerMinute(projectId) {
  let h = 0;
  for (let i = 0; i < projectId.length; i++) h = (h * 31 + projectId.charCodeAt(i)) >>> 0;
  return h % 60;
}

// 프로젝트별 마지막 스윕 시도 분 — tick 이 10초라 같은 분에 6번 걸린다.
// 서버 CAS 가 중복을 막긴 하지만, 굳이 레이트리밋에 걸리는 호출을 반복할 이유가 없다.
const lastSweepMinute = new Map();

/**
 * 이 프로젝트의 야간 스윕 시각인가 (UTC 기준, 분 단위로 분산) — 분당 1회만 true.
 * 성공 여부는 여기서 기록하지 않는다. 시도만으로 "오늘 끝"으로 치면 일시적 네트워크
 * 오류 한 번이 그날의 유일한 기회를 소진한다. 중복 방지는 서버 CAS 가 맡는다.
 */
function isSweepWindow(projectId, now) {
  if (now.getUTCHours() !== TOKEN_CHECK_HOUR_UTC) return false;
  const minute = now.getUTCMinutes();
  if (minute !== staggerMinute(projectId)) return false;
  const key = `${now.getUTCDate()}:${minute}:${lastSweepSeq(now)}`;
  if (lastSweepMinute.get(projectId) === key) return false;
  lastSweepMinute.set(projectId, key);
  return true;
}

/** 스윕 창 안에서는 tick 마다 재시도할 수 있게 초 단위 구간을 키에 섞는다 */
function lastSweepSeq(now) {
  return Math.floor(now.getUTCSeconds() / Math.max(1, Math.round(INTERVAL / 1000)));
}

async function tick() {
  // 한 페이지만 읽으면 그 뒤의 프로젝트는 영영 처리되지 않는다 — 커서를 끝까지 따라간다.
  // 페이지 수에 상한을 둬, 커서가 진전되지 않는 이상 상황에서 tick 이 멈추지 않게 한다.
  let projects = [];
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const q = cursor ? `?before=${encodeURIComponent(cursor.ts)}&before_id=${cursor.id}` : "";
      const res = await fetch(`${BASE}/api/admin/projects${q}`, { headers: { "x-admin-token": ADMIN } });
      const json = await res.json();
      const batch = json?.data?.projects ?? [];
      projects.push(...batch);
      cursor = json?.data?.next ?? null;
      if (!cursor) break;
    }
  } catch {
    return;
  }
  // 사라진 프로젝트의 기록은 지운다 — 장기 실행 워커에서 무한히 쌓이지 않게
  if (lastSweepMinute.size > projects.length) {
    const live = new Set(projects.map((p) => p.id));
    for (const id of lastSweepMinute.keys()) if (!live.has(id)) lastSweepMinute.delete(id);
  }

  for (const p of projects) {
    // 프로젝트마다 다시 읽는다 — 한 번 캡처하면 스윕이 길어졌을 때 뒤쪽 프로젝트가
    // 이미 지나간 분(minute)으로 판정된다
    const now = new Date();
    await post(`/api/admin/projects/${p.id}/process-queue`);
    await post(`/api/admin/projects/${p.id}/journeys/process`);
    await post(`/api/admin/projects/${p.id}/webhooks/retry`);

    // 서버가 CAS 로 클레임하므로 하루 1회만 실제로 수행된다.
    // 토큰이 많으면 partial 로 끊겨 오므로 완주할 때까지 이어서 호출한다.
    if (TOKEN_CHECK_ENABLED && isSweepWindow(p.id, now)) {
      for (let round = 0; round < TOKEN_CHECK_MAX_ROUNDS; round++) {
        const res = await post(
          `/api/admin/projects/${p.id}/devices/check?min_interval_hours=${TOKEN_CHECK_MIN_INTERVAL_HOURS}`
        );
        if (!res) {
          // 네트워크/서버 오류 — 커서는 서버에 남아 있으므로 다음 tick 이 이어받는다
          console.warn(`[worker] token sweep for ${p.id} failed; will retry`);
          break;
        }
        if (res.data?.leaseLost) {
          console.warn(`[worker] token sweep for ${p.id} lost its lease to another worker`);
          break;
        }
        if (res.data?.unverified > 0) {
          console.warn(`[worker] token sweep for ${p.id}: ${res.data.unverified} tokens could not be validated`);
        }
        if (!res.data?.partial) break;
        if (round === TOKEN_CHECK_MAX_ROUNDS - 1) {
          // 커서는 남아 있으므로 다음 창에서 이어진다. 조용히 끝난 것처럼 보이지 않게 남긴다.
          console.warn(`[worker] token sweep for ${p.id} hit the round cap; will resume next window`);
        }
      }
    }
  }
}

console.log(
  `[worker] started — polling ${BASE} every ${INTERVAL}ms` +
    (TOKEN_CHECK_ENABLED ? `; token sweep at ${TOKEN_CHECK_HOUR_UTC}:xx UTC (staggered per project)` : "; token sweep disabled")
);
// tick 은 프로젝트를 순차 처리하고, 스윕 창에서는 한 번에 수 분이 걸릴 수 있다.
// 겹쳐 돌면 그동안 큐/저니/웹훅 호출이 중복으로 쌓인다.
let ticking = false;
async function safeTick() {
  if (ticking) return;
  ticking = true;
  try {
    await tick();
  } catch {
    /* 다음 tick 에서 재시도 */
  } finally {
    ticking = false;
  }
}

setInterval(safeTick, INTERVAL);
safeTick();
