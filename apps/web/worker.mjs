/**
 * Notikit worker — 주기적으로 각 프로젝트의 큐/저니/웹훅을 처리한다.
 * 웹 서비스의 admin 엔드포인트를 폴링하는 경량 프로세스(별도 빌드 불필요).
 *
 * env: WORKER_BASE_URL(기본 http://localhost:3000), ADMIN_TOKEN, WORKER_INTERVAL_MS(기본 10000)
 */
const BASE = (process.env.WORKER_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;
const INTERVAL = Number(process.env.WORKER_INTERVAL_MS ?? 10_000);

if (!ADMIN) {
  console.error("[worker] ADMIN_TOKEN is required");
  process.exit(1);
}

const admin = { "x-admin-token": ADMIN, "content-type": "application/json" };

async function post(path) {
  try {
    await fetch(`${BASE}${path}`, { method: "POST", headers: admin, body: "{}" });
  } catch {
    /* 다음 tick 에서 재시도 */
  }
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
  for (const p of projects) {
    await post(`/api/admin/projects/${p.id}/process-queue`);
    await post(`/api/admin/projects/${p.id}/journeys/process`);
    await post(`/api/admin/projects/${p.id}/webhooks/retry`);
  }
}

console.log(`[worker] started — polling ${BASE} every ${INTERVAL}ms`);
setInterval(() => {
  tick().catch(() => {});
}, INTERVAL);
tick().catch(() => {});
