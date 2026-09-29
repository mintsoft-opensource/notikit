/**
 * Notikit worker — 주기적으로 각 프로젝트의 큐/저니/웹훅을 처리한다.
 * 웹 서비스의 admin 엔드포인트를 폴링하는 경량 프로세스(별도 빌드 불필요).
 *
 * env: WORKER_BASE_URL(기본 http://localhost:3000), ADMIN_TOKEN, WORKER_INTERVAL_MS(기본 10000),
 *      WORKER_REQUEST_TIMEOUT_MS(기본 120000), WORKER_CONCURRENCY(기본 4),
 *      WORKER_WEBHOOK_SWEEP_MS(기본 60000), WORKER_SHUTDOWN_TIMEOUT_MS(기본 30000)
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE = (process.env.WORKER_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const ADMIN = process.env.ADMIN_TOKEN;

/**
 * 구조화 로그 — 웹(`src/lib/logger.ts`)과 **같은 한 줄 JSON 형식**을 쓴다.
 * 워커는 별도 프로세스(빌드 없는 .mjs)라 그 모듈을 가져올 수 없어 최소한만 다시 쓴다.
 * 형식이 같아야 web/worker 로그를 한 번에 jq 로 자를 수 있다.
 */
const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const LOG_MIN = LOG_RANK[(process.env.NOTIKIT_LOG_LEVEL ?? "info").trim().toLowerCase()] ?? LOG_RANK.info;

function logEvent(level, event, fields = {}) {
  if ((LOG_RANK[level] ?? LOG_RANK.info) < LOG_MIN) return;
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    // 토큰·시크릿류는 키 이름으로 거른다 (웹 로거와 같은 규칙)
    if (/(token|secret|password|phone|email|authorization|auth|cookie|credential|api[-_]?key|signature)/i.test(k)) continue;
    clean[k] = typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}…` : v;
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, instance: "worker", ...clean });
  if ((LOG_RANK[level] ?? 0) >= LOG_RANK.warn) process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

const log = {
  info: (event, fields) => logEvent("info", event, fields),
  warn: (event, fields) => logEvent("warn", event, fields),
  error: (event, fields) => logEvent("error", event, fields),
};

/** 예외 → 짧은 사유 문자열 */
function reasonOf(e) {
  return e?.name === "TimeoutError" ? "timeout" : (e?.message ?? String(e));
}

/** 숫자 env — 빈 문자열/쓰레기값이 조용히 0 이나 NaN 이 되지 않게. */
function numEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) {
    log.warn("worker.env_invalid", { name, fallback });
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
// 창은 **서버 UTC** 기준이다. 프로젝트의 방해금지 시간대는 `projects.timezone`(IANA) 으로
// 재므로 이 창과는 무관하다 — 여기서 UTC 를 쓰는 건 배포 지역이 달라도 부하 분산이
// 같은 시각에 걸리게 하려는 것뿐이다.
const TOKEN_CHECK_ENABLED = process.env.TOKEN_CHECK_ENABLED !== "false";
const TOKEN_CHECK_HOUR_UTC = numEnv("TOKEN_CHECK_HOUR_UTC", 0, { min: 0, max: 23 });
const TOKEN_CHECK_MIN_INTERVAL_HOURS = numEnv("TOKEN_CHECK_MIN_INTERVAL_HOURS", 20, { min: 0, max: 720 });
// partial 이어받기 상한 — 무한 루프로 tick 을 붙잡지 않게. 남으면 다음 tick 에서 이어진다.
const TOKEN_CHECK_MAX_ROUNDS = numEnv("TOKEN_CHECK_MAX_ROUNDS", 20, { min: 1 });

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
    if (!res.ok) log.warn("worker.request_failed", { path, status: res.status, reason: json?.error ?? null });
    return json;
  } catch (e) {
    // 다음 tick 에서 재시도. 조용히 삼키면 서버가 죽어 있어도 워커 로그가 깨끗해 보인다.
    log.warn("worker.request_failed", { path, status: null, reason: reasonOf(e), timeout_ms: REQUEST_TIMEOUT_MS });
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
        log.error("worker.project_failed", { project_id: item?.id ?? null, reason: reasonOf(e) });
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

/** UTC 날짜 키(YYYY-MM-DD). 야간 작업을 "그날 끝냈는가"로 세는 단위다. */
export function utcDay(now) {
  return now.toISOString().slice(0, 10);
}

/** 오늘(UTC) 이 프로젝트의 야간 스윕 시각(ms). 시는 TOKEN_CHECK_HOUR_UTC, 분은 프로젝트별로 흩어진다. */
export function sweepTimeFor(projectId, now, hourUtc = TOKEN_CHECK_HOUR_UTC) {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc, staggerMinute(projectId));
}

/**
 * 이 프로젝트의 야간 작업을 지금 돌려야 하는가 — 오늘의 스윕 시각이 **지났고**, 오늘 아직
 * 끝내지 못했다. 예전엔 그 1분 창 안에 tick 이 걸려야만 돌았는데, 앞선 tick 이 길어지면
 * (대형 발송·purge) 창을 통째로 건너뛰어 그날 purge 가 없었다. 로그가 쌓여 디스크가 차는 길이다.
 *
 * "끝냈다"는 성공했을 때만 기록한다(markNightlyDone). 실패나 done:false 는 다음 tick 이
 * 이어받는다. 중복 실행은 서버가 막는다 — purge 는 멱등이고 토큰 점검은 CAS 로 클레임한다.
 */
export function isSweepDue(projectId, now, doneDay, hourUtc = TOKEN_CHECK_HOUR_UTC) {
  if (now.getTime() < sweepTimeFor(projectId, now, hourUtc)) return false;
  return doneDay !== utcDay(now);
}

/** 응답을 보고 오늘 몫을 끝냈는지. 오류 본문(`{error}`)이나 무응답은 끝나지 않은 것이다. */
export const nightlyDone = {
  // done:false 는 한 호출에서 다 못 지웠다는 뜻이다(서버가 tick 독점을 막으려 끊는다)
  purge: (res) => !!res?.data && res.data.done !== false,
  // 이미 검사됐거나(alreadyChecked) 다른 워커가 리스를 가져갔으면(leaseLost) 우리 몫은 끝났다
  tokens: (res) => !!res?.data && (res.data.alreadyChecked === true || res.data.leaseLost === true || !res.data.partial),
};

// 프로젝트별로 야간 작업을 끝낸 UTC 날짜. 메모리에만 둔다 — 재기동하면 한 번 더 돌 수 있지만
// purge 는 멱등이고 토큰 점검은 서버가 min_interval_hours 로 거른다.
const purgeDoneDay = new Map();
const tokenDoneDay = new Map();

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
    log.warn("worker.webhook_sweep_failed", { reason: "no response" });
    return;
  }
  const { retried = 0, skipped = 0, dead = 0, candidates = 0 } = res.data ?? {};
  if (retried > 0 || skipped > 0) {
    log.info("worker.webhook_sweep", { retried, skipped, dead, candidates });
  }
  // 시도를 다 쓴 배달은 그냥 멈춘다 — 여기서 찍지 않으면 아무도 모른 채 이벤트가 사라진다
  if (dead > 0) {
    log.error("worker.webhook_dead_letters", { dead, instance_total: res.data?.webhooks?.deadLetters ?? null });
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
    log.warn("worker.ratelimit_fallback", { delta, instance_total: fallbacks, short_circuits: rl.shortCircuits ?? null, scope: rl.scope ?? "process" });
  }
}

/**
 * 전 프로젝트 목록. 실패하면 null — 호출자는 그 tick 을 건너뛴다.
 *
 * 한 페이지만 읽으면 그 뒤의 프로젝트는 영영 처리되지 않는다 — 커서를 끝까지 따라간다.
 * 페이지 수에 상한을 둬, 커서가 진전되지 않는 이상 상황에서 tick 이 멈추지 않게 한다.
 *
 * `!res.ok` 를 반드시 본다. 예전엔 401 본문을 그대로 파싱해 "프로젝트 0개"로 읽었고,
 * ADMIN_TOKEN 이 web 과 어긋난 설치가 경고 한 줄 없이 아무것도 보내지 않았다.
 */
export async function listProjects(fetchImpl = fetch) {
  const projects = [];
  try {
    let cursor = null;
    for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
      const q = cursor ? `?before=${encodeURIComponent(cursor.ts)}&before_id=${cursor.id}` : "";
      const res = await fetchImpl(`${BASE}/api/admin/projects${q}`, {
        headers: { "x-admin-token": ADMIN },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        log.warn("worker.project_list_failed", {
          status: res.status,
          reason: body?.error ?? null,
          // 401/403 은 거의 항상 worker 와 web 의 ADMIN_TOKEN 불일치다
          hint: res.status === 401 || res.status === 403 ? "check ADMIN_TOKEN matches web" : undefined,
        });
        return null;
      }
      const json = await res.json();
      projects.push(...(json?.data?.projects ?? []));
      cursor = json?.data?.next ?? null;
      if (!cursor) break;
    }
  } catch (e) {
    log.warn("worker.project_list_failed", { status: null, reason: reasonOf(e) });
    return null;
  }
  return projects;
}

async function tick() {
  await sweepWebhooks(Date.now());

  const projects = await listProjects();
  // 목록을 못 읽었으면 이번 tick 은 건너뛴다. 빈 목록으로 진행하면 아래 정리가
  // 야간 작업 기록을 모두 지워, 다음 tick 에 그날 끝낸 스윕을 다시 돈다.
  if (!projects) return;
  // 사라진 프로젝트의 기록은 지운다 — 장기 실행 워커에서 무한히 쌓이지 않게
  const live = new Set(projects.map((p) => p.id));
  for (const done of [purgeDoneDay, tokenDoneDay]) {
    if (done.size <= projects.length) continue;
    for (const id of done.keys()) if (!live.has(id)) done.delete(id);
  }

  await runLimited(projects, CONCURRENCY, processProject);
}

async function processProject(p) {
  // 프로젝트마다 다시 읽는다 — tick 이 자정(UTC)을 넘기면 뒤쪽 프로젝트는 다음 날로 판정돼야 한다
  const now = new Date();
  // 반복 예약이 먼저다 — 도래한 예약은 이번 tick 의 큐 처리에 바로 실려 나간다.
  // 뒤에 두면 만들어진 로그가 다음 tick(기본 10초)까지 그대로 앉아 있다.
  const sched = await post(`/api/admin/projects/${p.id}/schedules/process`);
  if (sched?.data?.fired > 0 || sched?.data?.skipped > 0) {
    // 건너뛴 회차는 반드시 남긴다 — 다운타임 뒤 "안 온 푸시"의 유일한 근거다
    log.info("worker.schedules", { project_id: p.id, fired: sched.data.fired, skipped: sched.data.skipped });
  }
  await post(`/api/admin/projects/${p.id}/process-queue`);
  await post(`/api/admin/projects/${p.id}/journeys/process`);
  // 웹훅 재시도는 프로젝트별이 아니라 sweepWebhooks() 가 한 번에 처리한다.

  // 로그 리텐션 purge — 로그가 코어 테이블과 같은 DB 에 있어서, 이게 멈추면
  // 디스크가 차고 푸시 전체가 선다. 한 번에 다 못 지우면 done:false 로 오고
  // 다음 tick 에서 이어 간다(한 tick 을 독점하지 않게 서버가 끊는다).
  if (isSweepDue(p.id, now, purgeDoneDay.get(p.id))) {
    const res = await post(`/api/admin/projects/${p.id}/logs/purge`);
    if (res?.data?.purged > 0) {
      log.info("worker.logs_purged", { project_id: p.id, purged: res.data.purged, done: res.data.done });
    }
    if (nightlyDone.purge(res)) purgeDoneDay.set(p.id, utcDay(now));
  }

  // 서버가 CAS 로 클레임하므로 하루 1회만 실제로 수행된다.
  // 토큰이 많으면 partial 로 끊겨 오므로 완주할 때까지 이어서 호출한다.
  if (TOKEN_CHECK_ENABLED && isSweepDue(p.id, now, tokenDoneDay.get(p.id))) {
    let res = null;
    for (let round = 0; round < TOKEN_CHECK_MAX_ROUNDS; round++) {
      res = await post(
        `/api/admin/projects/${p.id}/devices/check?min_interval_hours=${TOKEN_CHECK_MIN_INTERVAL_HOURS}`
      );
      if (!res?.data) {
        // 네트워크/서버 오류 — 커서는 서버에 남아 있으므로 다음 tick 이 이어받는다
        log.warn("worker.token_sweep_failed", { project_id: p.id, reason: res?.error ?? "no response" });
        break;
      }
      if (res.data.leaseLost) {
        log.warn("worker.token_sweep_lease_lost", { project_id: p.id });
        break;
      }
      if (res.data.unverified > 0) {
        log.warn("worker.token_sweep_unverified", { project_id: p.id, unverified: res.data.unverified });
      }
      if (!res.data.partial) break;
      if (round === TOKEN_CHECK_MAX_ROUNDS - 1) {
        // 커서는 남아 있으므로 다음 tick 에서 이어진다. 조용히 끝난 것처럼 보이지 않게 남긴다.
        log.warn("worker.token_sweep_round_cap", { project_id: p.id, rounds: TOKEN_CHECK_MAX_ROUNDS });
      }
    }
    if (nightlyDone.tokens(res)) tokenDoneDay.set(p.id, utcDay(now));
  }
}

/**
 * 이 파일이 직접 실행됐을 때만 돈다. 테스트(worker.test.mjs)가 import 해서 스케줄 판정만
 * 확인할 수 있게 — import 만으로 타이머가 돌고 ADMIN_TOKEN 이 없다며 죽으면 안 된다.
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function main() {
  if (!ADMIN) {
    log.error("worker.config_missing", { name: "ADMIN_TOKEN" });
    process.exit(1);
  }

  log.info("worker.started", {
    base: BASE,
    interval_ms: INTERVAL,
    concurrency: CONCURRENCY,
    request_timeout_ms: REQUEST_TIMEOUT_MS,
    token_sweep_hour_utc: TOKEN_CHECK_ENABLED ? TOKEN_CHECK_HOUR_UTC : null,
  });
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
        log.error("worker.tick_failed", { reason: reasonOf(e) }); // 다음 tick 에서 재시도
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
      log.info("worker.shutdown", { signal, waited_ms: 0 });
      process.exit(0);
    }
    log.info("worker.shutdown_waiting", { signal, timeout_ms: SHUTDOWN_TIMEOUT_MS });
    let timedOut = false;
    const guard = new Promise((resolve) =>
      setTimeout(() => {
        timedOut = true;
        resolve();
      }, SHUTDOWN_TIMEOUT_MS).unref()
    );
    await Promise.race([inFlight.catch(() => {}), guard]);
    if (timedOut) log.warn("worker.shutdown_timeout", { signal, timeout_ms: SHUTDOWN_TIMEOUT_MS });
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

if (isMain()) main();
