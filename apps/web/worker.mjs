/**
 * Notikit worker — 주기적으로 각 프로젝트의 큐/저니/웹훅을 처리한다.
 * 웹 서비스의 admin 엔드포인트를 폴링하는 경량 프로세스(별도 빌드 불필요).
 *
 * env: WORKER_BASE_URL(기본 http://localhost:3000), ADMIN_TOKEN, WORKER_INTERVAL_MS(기본 10000),
 *      WORKER_REQUEST_TIMEOUT_MS(기본 120000), WORKER_CONCURRENCY(기본 4),
 *      WORKER_WEBHOOK_SWEEP_MS(기본 60000), WORKER_SHUTDOWN_TIMEOUT_MS(기본 30000)
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
// 요청마다 마감 시각. 서버가 응답 없이 매달리면 tick 전체가 멈추고(ticking 플래그) 모든 프로젝트의
// 발송이 선다. 끊어도 서버 쪽 처리는 계속되고, 미완료 로그는 stale 재클레임으로 이어진다.
const REQUEST_TIMEOUT_MS = numEnv("WORKER_REQUEST_TIMEOUT_MS", 120_000, { min: 1000 });
// 동시에 처리하는 프로젝트 수. 순차면 대형 발송 하나가 뒤의 모든 프로젝트를 붙잡는다.
const CONCURRENCY = numEnv("WORKER_CONCURRENCY", 4, { min: 1, max: 64 });
/** 프로젝트 목록 페이지 상한(페이지당 200) — 커서가 안 끝나도 tick 이 갇히지 않게 */
const MAX_PROJECT_PAGES = 50;
// 웹훅 재시도 스윕 주기. 백오프가 분 단위라 tick(10초)마다 부르면 후보가 0인 질의만 반복된다.
const WEBHOOK_SWEEP_MS = numEnv("WORKER_WEBHOOK_SWEEP_MS", 60_000, { min: 5_000 });
// 종료 신호 뒤 진행 중 tick 을 기다리는 상한. 넘기면 그대로 내려간다(미완료 작업은 다음 기동이 이어받는다).
const SHUTDOWN_TIMEOUT_MS = numEnv("WORKER_SHUTDOWN_TIMEOUT_MS", 30_000, { min: 0 });

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
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: admin,
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) console.warn(`[worker] POST ${path} → ${res.status}${json?.error ? `: ${json.error}` : ""}`);
    return json;
  } catch (e) {
    // 다음 tick 에서 재시도. 조용히 삼키면 서버가 죽어 있어도 워커 로그가 깨끗해 보인다.
    const reason = e?.name === "TimeoutError" ? `timed out after ${REQUEST_TIMEOUT_MS}ms` : (e?.message ?? String(e));
    console.warn(`[worker] POST ${path} failed: ${reason}`);
    return null;
  }
}

/** 동시성 제한 실행 — 한 프로젝트의 실패가 다른 프로젝트를 멈추지 않게 각자 잡는다 */
async function runLimited(items, limit, fn) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await fn(item);
      } catch (e) {
        console.error(`[worker] project ${item?.id} failed: ${e?.message ?? e}`);
      }
    }
  });
  await Promise.all(lanes);
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

let lastWebhookSweep = 0;

/**
 * 실패한 웹훅 배달을 지수 백오프로 재시도한다(전 프로젝트 한 번에).
 * 프로젝트마다 부르지 않는 이유: 프로젝트가 늘어도 tick 당 요청 수가 고정이고,
 * 오래 밀린 배달이 프로젝트 순회 순서에 갇히지 않는다.
 */
async function sweepWebhooks(now) {
  if (now - lastWebhookSweep < WEBHOOK_SWEEP_MS) return;
  lastWebhookSweep = now;
  const res = await post("/api/internal/webhooks/sweep");
  if (!res) {
    console.warn("[worker] webhook sweep failed; will retry next window");
    return;
  }
  const { retried = 0, skipped = 0, dead = 0, candidates = 0 } = res.data ?? {};
  if (retried > 0 || skipped > 0) {
    console.log(`[worker] webhook sweep: retried ${retried}, skipped ${skipped} of ${candidates} candidates`);
  }
  // 시도를 다 쓴 배달은 그냥 멈춘다 — 여기서 찍지 않으면 아무도 모른 채 이벤트가 사라진다
  if (dead > 0) {
    const total = res.data?.webhooks?.deadLetters;
    console.error(`[worker] ${dead} webhook deliveries exhausted all attempts and were dropped${total ? ` (${total} since this server started)` : ""}`);
  }
  reportLimiterHealth(res.data?.rateLimit);
}

let lastFallbacks = 0;

/**
 * 공유 rate limit 이 인메모리로 떨어지고 있으면 알린다.
 * 폴백은 요청을 막지 않으므로 증상이 없다 — 한도만 replica 배수로 느슨해진다.
 */
function reportLimiterHealth(rl) {
  if (!rl?.shared) return;
  const fallbacks = rl.fallbacks ?? 0;
  const delta = fallbacks - lastFallbacks;
  lastFallbacks = fallbacks;
  if (delta > 0) {
    console.warn(`[worker] shared rate limit fell back to per-instance counting ${delta} times since the last sweep (${fallbacks} total)`);
  }
}

async function tick() {
  await sweepWebhooks(Date.now());

  // 한 페이지만 읽으면 그 뒤의 프로젝트는 영영 처리되지 않는다 — 커서를 끝까지 따라간다.
  // 페이지 수에 상한을 둬, 커서가 진전되지 않는 이상 상황에서 tick 이 멈추지 않게 한다.
  let projects = [];
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const q = cursor ? `?before=${encodeURIComponent(cursor.ts)}&before_id=${cursor.id}` : "";
      const res = await fetch(`${BASE}/api/admin/projects${q}`, {
        headers: { "x-admin-token": ADMIN },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const json = await res.json();
      const batch = json?.data?.projects ?? [];
      projects.push(...batch);
      cursor = json?.data?.next ?? null;
      if (!cursor) break;
    }
  } catch (e) {
    console.warn(`[worker] listing projects failed: ${e?.message ?? e}`);
    return;
  }
  // 사라진 프로젝트의 기록은 지운다 — 장기 실행 워커에서 무한히 쌓이지 않게
  if (lastSweepMinute.size > projects.length) {
    const live = new Set(projects.map((p) => p.id));
    for (const id of lastSweepMinute.keys()) if (!live.has(id)) lastSweepMinute.delete(id);
  }

  await runLimited(projects, CONCURRENCY, processProject);
}

async function processProject(p) {
  // 프로젝트마다 다시 읽는다 — 한 번 캡처하면 스윕이 길어졌을 때 뒤쪽 프로젝트가
  // 이미 지나간 분(minute)으로 판정된다
  const now = new Date();
  // 반복 예약이 먼저다 — 도래한 예약은 이번 tick 의 큐 처리에 바로 실려 나간다.
  // 뒤에 두면 만들어진 로그가 다음 tick(기본 10초)까지 그대로 앉아 있다.
  const sched = await post(`/api/admin/projects/${p.id}/schedules/process`);
  if (sched?.data?.fired > 0 || sched?.data?.skipped > 0) {
    // 건너뛴 회차는 반드시 남긴다 — 다운타임 뒤 "안 온 푸시"의 유일한 근거다
    console.log(`[worker] schedules for ${p.id}: fired ${sched.data.fired}, skipped ${sched.data.skipped}`);
  }
  await post(`/api/admin/projects/${p.id}/process-queue`);
  await post(`/api/admin/projects/${p.id}/journeys/process`);
  // 웹훅 재시도는 프로젝트별이 아니라 sweepWebhooks() 가 한 번에 처리한다.

  // isSweepWindow 는 호출하면 창을 소비한다(분당 1회만 true). 야간 작업이 둘이므로
  // **한 번만 물어보고 공유한다** — 두 번 부르면 뒤엣것이 조용히 건너뛰어진다.
  const sweeping = isSweepWindow(p.id, now);

  // 로그 리텐션 purge — 로그가 코어 테이블과 같은 DB 에 있어서, 이게 멈추면
  // 디스크가 차고 푸시 전체가 선다. 한 번에 다 못 지우면 done:false 로 오고
  // 다음 창에서 이어 간다(한 tick 을 독점하지 않게 서버가 끊는다).
  if (sweeping) {
    const res = await post(`/api/admin/projects/${p.id}/logs/purge`);
    if (res?.data?.purged > 0) {
      console.log(`[worker] purged ${res.data.purged} logs for ${p.id} (done=${res.data.done})`);
    }
  }

  // 서버가 CAS 로 클레임하므로 하루 1회만 실제로 수행된다.
  // 토큰이 많으면 partial 로 끊겨 오므로 완주할 때까지 이어서 호출한다.
  if (TOKEN_CHECK_ENABLED && sweeping) {
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

console.log(
  `[worker] started — polling ${BASE} every ${INTERVAL}ms (concurrency ${CONCURRENCY}, timeout ${REQUEST_TIMEOUT_MS}ms)` +
    (TOKEN_CHECK_ENABLED ? `; token sweep at ${TOKEN_CHECK_HOUR_UTC}:xx UTC (staggered per project)` : "; token sweep disabled")
);
// tick 은 스윕 창에서 한 번에 수 분이 걸릴 수 있다.
// 겹쳐 돌면 그동안 큐/저니/웹훅 호출이 중복으로 쌓인다.
let inFlight = null;
let stopping = false;
async function safeTick() {
  if (inFlight || stopping) return;
  inFlight = (async () => {
    try {
      await tick();
    } catch (e) {
      console.error(`[worker] tick failed: ${e?.message ?? e}`); // 다음 tick 에서 재시도
    } finally {
      inFlight = null;
    }
  })();
  await inFlight;
}

const timer = setInterval(safeTick, INTERVAL);
safeTick();

/**
 * 종료 신호 — 진행 중인 tick 을 기다린다.
 * 그냥 죽으면 클레임해 둔 발송·배달이 stale 재클레임 시각까지 멈춰 있고, 무엇보다
 * FCM 에 이미 보낸 건의 결과 기록이 유실된다. 무한정 기다리지는 않는다(컨테이너가 SIGKILL 한다).
 */
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  if (!inFlight) {
    console.log(`[worker] ${signal} — nothing in flight, exiting`);
    process.exit(0);
  }
  console.log(`[worker] ${signal} — waiting up to ${SHUTDOWN_TIMEOUT_MS}ms for the current tick`);
  let timedOut = false;
  const guard = new Promise((resolve) =>
    setTimeout(() => {
      timedOut = true;
      resolve();
    }, SHUTDOWN_TIMEOUT_MS).unref()
  );
  await Promise.race([inFlight.catch(() => {}), guard]);
  if (timedOut) console.warn("[worker] shutdown timed out; the next start will resume unfinished work");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
