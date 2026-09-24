/**
 * Notikit 업데이터 — 고객사 인스턴스를 새 버전으로 올린다.
 *
 * 콘솔과는 **DB 로만** 이야기한다. HTTP 포트를 열지 않는다. web 컨테이너에 Docker
 * 소켓을 주지 않기 위해서다 — 소켓은 사실상 호스트 root 권한이라, 공개 API 를
 * 서빙하는 프로세스가 쥐고 있으면 거기서 나는 사고가 곧 호스트 장악이 된다.
 * 여기서만 쥐고, 여기는 바깥에서 닿을 수 없다.
 *
 * 순서가 곧 안전장치다.
 *   받기 → 백업 → 마이그레이션 → 교체 → 확인
 * 마이그레이션이 실패하면 구버전 web 이 **그대로 살아 있다**. 그래서 실패해도
 * 서비스는 계속된다. 반대로 교체를 먼저 하면 실패한 순간 내려간 채로 남는다.
 *
 * env: DATABASE_URL, COMPOSE_FILE, COMPOSE_PROJECT, BACKUP_DIR, REGISTRY_*
 */
import postgres from "postgres";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const DB_URL = process.env.DATABASE_URL;
const COMPOSE_FILE = process.env.COMPOSE_FILE ?? "/project/docker-compose.yml";
const PROJECT = process.env.COMPOSE_PROJECT ?? "notikit";
/** compose 파일이 있는 디렉터리. `./bundles` 같은 상대 경로가 여기를 기준으로 풀린다. */
const PROJECT_DIR = process.env.COMPOSE_PROJECT_DIR ?? path.dirname(COMPOSE_FILE);
const BACKUP_DIR = process.env.BACKUP_DIR ?? "/backups";
const POLL_MS = Number(process.env.UPDATER_POLL_MS ?? 5000);
/** 새 web 이 이 안에 건강해지지 않으면 실패로 본다 */
const HEALTH_TIMEOUT_MS = Number(process.env.UPDATER_HEALTH_TIMEOUT_MS ?? 180_000);
/**
 * 교체 후 확인은 **readiness** 로 본다. `/api/health` 는 liveness 라 DB 가 안 붙어도
 * 200 이고, 그것만 보면 설정이 깨진 인스턴스가 "성공한 업데이트"로 기록된다.
 */
const HEALTH_URL = process.env.UPDATER_HEALTH_URL ?? "http://web:3000/api/ready";
/**
 * 지금 돌고 있는 이미지를 가리키는 한 줄짜리 파일. compose 가 `${NOTIKIT_IMAGE}` 로
 * 읽는다. 교체도 되돌리기도 이 줄 하나를 바꾸고 `up` 하는 것이 전부다 —
 * compose 파일 본문을 고치면 고객이 손댄 설정과 충돌한다.
 *
 * **이 파일은 업데이터 소유다.** writeImage 가 통째로 덮어쓰므로 다른 설정을 같이
 * 두면 업데이트 한 번에 사라진다. 고객 설정은 `.env` 에 둔다.
 */
const IMAGE_ENV_FILE = process.env.IMAGE_ENV_FILE ?? "/project/.notikit-image.env";
/**
 * compose 가 `${NOTIKIT_IMAGE}` 를 풀 때 읽을 파일들.
 *
 * compose 는 기본적으로 프로젝트 디렉터리의 `.env` **하나만** 치환에 쓴다. 서비스의
 * `env_file:` 은 컨테이너 환경변수일 뿐 치환과 무관하다. 그래서 `--env-file` 로
 * 명시하지 않으면 `.notikit-image.env` 를 아무도 읽지 않고, 업데이터가 그 파일을
 * 갱신해도 compose 는 계속 **예전 이미지**를 띄운다 — 업데이트도 롤백도 성공했다고
 * 기록되면서 실제로는 아무것도 바뀌지 않는다.
 *
 * 순서가 우선순위다(뒤가 이긴다). `.env` 에 NOTIKIT_IMAGE 를 적어 둔 설치본이 있어도
 * 업데이터가 쓴 값이 이긴다.
 */
const ENV_FILES = (process.env.COMPOSE_ENV_FILES ?? `${path.join(PROJECT_DIR, ".env")},${IMAGE_ENV_FILE}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
/**
 * 폐쇄망 반입 번들을 놓는 곳. 레지스트리에 닿을 수 없는 고객은 여기에 파일을 두고
 * 콘솔에서 고른다. 콘솔로 업로드받지 않는 이유는 번들이 수 GB 라, HTTP 업로드가
 * 실패하는 지점이 너무 많기 때문이다 — 파일은 이미 그 박스에 반입되어 있다.
 */
const BUNDLE_DIR = process.env.BUNDLE_DIR ?? "/bundles";
const REGISTRY = process.env.REGISTRY_SERVER ?? "";
const REGISTRY_USER = process.env.REGISTRY_USERNAME ?? "";
const REGISTRY_PASSWORD = process.env.REGISTRY_PASSWORD ?? "";

if (!DB_URL) {
  console.error("[updater] DATABASE_URL is required");
  process.exit(1);
}

const sql = postgres(DB_URL, { max: 2 });

/** 작업 로그에 한 줄 덧붙인다. 실패했을 때 사람이 읽을 수 있는 유일한 기록이다. */
async function log(jobId, line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(`[updater] ${line}`);
  await sql`update update_jobs set log = log || ${stamped + "\n"} where id = ${jobId}`;
}

async function setStep(jobId, step) {
  await sql`update update_jobs set step = ${step} where id = ${jobId}`;
}

/**
 * 명령 실행. 출력은 그대로 작업 로그로 흘린다 — 실패 원인이 대개 여기 있다.
 * 셸을 거치지 않는다(인자 배열). 버전 문자열 같은 값이 명령으로 해석될 여지를 없앤다.
 */
function run(jobId, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, shell: false });
    let tail = "";

    const collect = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split("\n")) {
        if (line.trim()) log(jobId, line.trim()).catch(() => {});
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(tail);
      else reject(new Error(`${cmd} ${args[0] ?? ""} exited ${code}\n${tail.slice(-800)}`));
    });
  });
}

/**
 * 존재하는 env 파일만 넘긴다. 없는 경로를 `--env-file` 로 주면 compose 가 즉시
 * 실패한다 — 첫 업데이트라 `.notikit-image.env` 가 아직 없을 수 있다.
 */
async function envFileArgs() {
  const args = [];
  for (const file of ENV_FILES) {
    try {
      await access(file);
      args.push("--env-file", file);
    } catch {
      // 없으면 조용히 건너뛴다. 치환은 나머지 파일과 프로세스 환경으로 이뤄진다.
    }
  }
  return args;
}

const compose = async (jobId, ...args) =>
  run(jobId, "docker", [
    "compose",
    "-f",
    COMPOSE_FILE,
    "--project-directory",
    PROJECT_DIR,
    ...(await envFileArgs()),
    "-p",
    PROJECT,
    ...args,
  ]);

async function readCurrentImage() {
  try {
    const m = /^NOTIKIT_IMAGE=(.+)$/m.exec(await readFile(IMAGE_ENV_FILE, "utf8"));
    return m ? m[1].trim() : null;
  } catch {
    return null; // 첫 업데이트 — 아직 파일이 없다
  }
}

/**
 * 같은 디렉터리에 쓰고 rename 한다. 이 한 줄이 다음 `up` 이 띄울 버전을 결정하므로,
 * 쓰다 만 파일이 남으면 compose 가 이미지를 풀지 못해 스택 전체가 뜨지 않는다.
 */
async function writeImage(ref) {
  const tmp = `${IMAGE_ENV_FILE}.tmp`;
  await writeFile(tmp, `NOTIKIT_IMAGE=${ref}\n`, "utf8");
  await rename(tmp, IMAGE_ENV_FILE);
}

/**
 * 프라이빗 레지스트리 로그인. 자격증명은 인자가 아니라 stdin 으로 넘긴다 —
 * 인자로 주면 호스트의 프로세스 목록에 그대로 보인다.
 */
async function registryLogin(jobId) {
  if (!REGISTRY || !REGISTRY_USER || !REGISTRY_PASSWORD) return;
  await new Promise((resolve, reject) => {
    const child = spawn("docker", ["login", REGISTRY, "-u", REGISTRY_USER, "--password-stdin"], { shell: false });
    let err = "";
    child.stderr.on("data", (b) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker login failed: ${err.slice(-400)}`))));
    child.stdin.end(REGISTRY_PASSWORD);
  });
  await log(jobId, `authenticated to ${REGISTRY}`);
}

/** 새 web 이 실제로 응답하는지. 컨테이너가 떴다는 것과 동작한다는 것은 다르다. */
async function waitHealthy(jobId) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastErr = "no attempt";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5000), cache: "no-store" });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  await log(jobId, `health check timed out: ${lastErr}`);
  return false;
}

/**
 * 마이그레이션 전 덤프. 마이그레이션은 앞으로만 간다 — 되돌릴 길은 이것뿐이다.
 * 실패하면 업데이트를 진행하지 않는다. 백업 없는 스키마 변경은 돌이킬 수 없다.
 */
async function backup(jobId, version) {
  await mkdir(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(BACKUP_DIR, `notikit-${version}-${stamp}.dump`);

  // custom 포맷 — pg_restore 로 선택 복원이 되고 크기도 작다
  await run(jobId, "pg_dump", ["--format=custom", "--no-owner", "--file", file, DB_URL]);
  await sql`update update_jobs set backup_path = ${file} where id = ${jobId}`;
  return file;
}

/**
 * 반입 번들에서 이미지를 꺼낸다.
 *
 * 체크섬을 먼저 본다. 번들은 USB 와 사람 손을 거쳐 오므로, 받은 것이 보낸 것과
 * 같은지 확인하지 않으면 무엇을 설치하는지 모르는 채로 설치하게 된다.
 */
async function loadBundle(jobId, name, expectedRef) {
  // 콘솔이 고른 이름이지만 경로 조작으로 디렉터리 밖을 읽지 못하게 한다
  const safe = path.basename(name);
  const file = path.join(BUNDLE_DIR, safe);
  await log(jobId, `loading air-gap bundle ${safe}`);

  const sums = await readFile(`${file}.sha256`, "utf8").catch(() => null);
  if (!sums) throw new Error(`${safe}.sha256 이 없어 번들을 검증할 수 없습니다`);
  const expected = sums.trim().split(/\s+/)[0];
  const actual = await sha256File(file);
  if (expected !== actual) {
    throw new Error(`번들 체크섬이 일치하지 않습니다 (기대 ${expected.slice(0, 16)}…, 실제 ${actual.slice(0, 16)}…)`);
  }
  await log(jobId, `checksum ok (${actual.slice(0, 16)}…)`);

  const work = await mkdtemp(path.join(tmpdir(), "notikit-bundle-"));
  try {
    await run(jobId, "tar", ["-xf", file, "-C", work]);

    const meta = JSON.parse(await readFile(path.join(work, "bundle.json"), "utf8"));
    // 번들이 가리키는 이미지와 콘솔에서 승인한 이미지가 달라선 안 된다
    if (meta.image !== expectedRef) {
      throw new Error(`번들의 이미지(${meta.image})가 승인된 이미지(${expectedRef})와 다릅니다`);
    }
    await run(jobId, "docker", ["load", "-i", path.join(work, "images.tar")]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (c) => hash.update(c))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function runJob(job) {
  const id = job.id;
  await sql`update update_jobs set status = 'running', started_at = now() where id = ${id}`;
  await log(id, `updating ${job.from_version} → ${job.target_version}`);

  // 태그가 아니라 다이제스트로 받는다. 태그는 나중에 다른 이미지를 가리키게 바뀔 수
  // 있어서, 콘솔에서 승인한 것과 실제로 설치되는 것이 달라질 수 있다.
  const ref = `${job.image}@${job.digest}`;

  // 실패했을 때 돌아갈 자리. 교체하기 전에 알아 둬야 한다.
  const previous = await readCurrentImage();

  await setStep(id, "pull");
  if (job.bundle_path) {
    // 폐쇄망 — 반입된 번들에서 꺼낸다. 레지스트리로 나가지 않는다.
    await loadBundle(id, job.bundle_path, ref);
  } else {
    await registryLogin(id);
    await log(id, `pulling ${ref}`);
    await run(id, "docker", ["pull", ref]);
  }
  // 받아 온 것이 승인한 그 이미지인지 확인한다. pull 은 다이제스트를 확인하지만,
  // 로컬에 같은 태그가 있으면 조용히 그것을 쓸 수 있다. 번들 경로에서는 더욱 중요하다.
  await run(id, "docker", ["image", "inspect", ref, "--format", "{{.Id}}"]);

  if (job.has_migrations) {
    await setStep(id, "backup");
    const file = await backup(id, job.from_version);
    await log(id, `backup written to ${file}`);
  } else {
    await log(id, "release has no migrations; skipping backup");
  }

  // 여기서부터 새 이미지를 가리킨다. compose 가 이 파일을 읽는다.
  await writeImage(ref);

  // 마이그레이션을 먼저 돌린다. 여기서 실패하면 구버전 web 이 그대로 살아 있어
  // 서비스가 끊기지 않는다. 교체를 먼저 하면 실패한 순간 내려간 채로 남는다.
  await setStep(id, "migrate");
  try {
    await compose(id, "up", "--no-deps", "--force-recreate", "migrate");
  } catch (err) {
    // 스키마는 그대로다. 이미지 참조만 되돌리면 아무 일도 없던 것이 된다.
    if (previous) await writeImage(previous);
    throw err;
  }
  await log(id, job.has_migrations ? "migrations applied" : "schema already up to date");

  await setStep(id, "restart");
  await compose(id, "up", "-d", "--no-deps", "web", "worker");

  await setStep(id, "verify");
  if (!(await waitHealthy(id))) {
    // 마이그레이션이 없었다면 이미지만 되돌리면 원상복구다. 있었다면 스키마가 이미
    // 앞으로 갔으므로 구버전 코드가 새 스키마를 만나게 된다 — 되돌리지 않고
    // 백업 복원을 안내한다. 어설픈 자동 복구가 더 큰 손상을 만든다.
    if (!job.has_migrations && previous) {
      await log(id, `rolling back to ${previous}`);
      await writeImage(previous);
      await compose(id, "up", "-d", "--no-deps", "web", "worker");
      throw new Error("새 버전이 health check 를 통과하지 못해 이전 버전으로 되돌렸습니다.");
    }
    throw new Error(
      "새 버전이 health check 를 통과하지 못했습니다. 스키마가 이미 적용되었으므로 자동으로 되돌리지 않습니다 — 백업에서 복원하세요."
    );
  }

  await sql`
    update update_jobs set status = 'succeeded', step = null, finished_at = now() where id = ${id}
  `;
  await log(id, `updated to ${job.target_version}`);
}

async function poll() {
  // 한 번에 하나만. 두 개가 겹치면 이미지 교체와 마이그레이션이 서로를 덮어쓴다.
  const [job] = await sql`
    select * from update_jobs where status = 'pending' order by created_at limit 1
  `;
  if (!job) return;

  try {
    await runJob(job);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await log(job.id, `FAILED: ${message}`).catch(() => {});
    await sql`
      update update_jobs set status = 'failed', error = ${message}, finished_at = now() where id = ${job.id}
    `.catch(() => {});
  }
}

/**
 * 업데이트 도중 업데이터가 죽으면 작업이 running 인 채로 남아, 다음에 아무것도
 * 집어가지 못한다. 기동 시 한 번 정리한다 — 무슨 일이 있었는지는 로그에 남아 있다.
 */
async function recoverOrphans() {
  const orphans = await sql`
    update update_jobs set status = 'failed', finished_at = now(),
      error = coalesce(error, '업데이터가 작업 도중 종료되었습니다. 로그를 확인하세요.')
    where status = 'running' returning id
  `;
  if (orphans.length > 0) console.warn(`[updater] marked ${orphans.length} interrupted job(s) as failed`);
}

let running = false;
async function safePoll() {
  if (running) return;
  running = true;
  try {
    await poll();
  } catch (err) {
    console.error("[updater] poll failed:", err);
  } finally {
    running = false;
  }
}

await recoverOrphans();
console.log(`[updater] watching for update jobs every ${POLL_MS}ms`);
setInterval(safePoll, POLL_MS);
safePoll();
