/**
 * Notikit worker — 주기적으로 각 프로젝트의 큐/저니/웹훅을 처리한다.
 * 웹 서비스의 admin 엔드포인트를 폴링하는 경량 프로세스(별도 빌드 불필요).
 *
 * env: WORKER_BASE_URL(기본 http://localhost:3000), ADMIN_TOKEN, WORKER_INTERVAL_MS(기본 10000)
 */
const BASE = (process.env.WORKER_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS ?? 10_000);

// 죽은 토큰 야간 스윕. FCM dry-run 이라 배달되지 않으므로 유저를 깨우지 않는다 —
// 새벽에 도는 이유는 방해 회피가 아니라 부하와 FCM 할당량 때문이다.
// 서버 로컬시각이 아니라 UTC 기준: 프로젝트 방해금지 시간대도 UTC 로 저장한다.
const TOKEN_CHECK_ENABLED = process.env.TOKEN_CHECK_ENABLED !== "false";
const TOKEN_CHECK_HOUR_UTC = Number(process.env.TOKEN_CHECK_HOUR_UTC ?? 0);
const TOKEN_CHECK_MIN_INTERVAL_HOURS = Number(process.env.TOKEN_CHECK_MIN_INTERVAL_HOURS ?? 20);
// partial 이어받기 상한 — 무한 루프로 tick 을 붙잡지 않게. 남으면 다음 창에서 이어진다.
const TOKEN_CHECK_MAX_ROUNDS = Number(process.env.TOKEN_CHECK_MAX_ROUNDS ?? 20);

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

/** 이 프로젝트의 야간 스윕 시각인가 (UTC 기준, 분 단위로 분산) — 분당 1회만 true */
function isSweepWindow(projectId, now) {
  if (now.getUTCHours() !== TOKEN_CHECK_HOUR_UTC) return false;
  const minute = now.getUTCMinutes();
  if (minute !== staggerMinute(projectId)) return false;
  const key = `${now.getUTCDate()}:${minute}`;
  if (lastSweepMinute.get(projectId) === key) return false;
  lastSweepMinute.set(projectId, key);
  return true;
}

async function tick() {
  let projects = [];
  try {
    const res = await fetch(`${BASE}/api/admin/projects`, { headers: { "x-admin-token": ADMIN } });
    const json = await res.json();
    projects = json?.data?.projects ?? [];
  } catch {
    return;
  }
  const now = new Date();
  for (const p of projects) {
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
        if (!res?.data?.partial) break;
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
setInterval(() => {
  tick().catch(() => {});
}, INTERVAL);
tick().catch(() => {});
