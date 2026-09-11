/**
 * 업데이트 서버 — 고객사 인스턴스가 "내가 올라갈 버전이 무엇인가"를 묻는 곳.
 *
 * 이 서버는 **우리가** 돌린다. 고객사 박스가 아니다. 하는 일은 셋뿐이다.
 *   1. 라이선스 확인 (오프라인 검증과 같은 코드 — 서명은 여기서도 같은 방식으로 본다)
 *   2. 이 고객이 받을 채널·고정 버전 결정
 *   3. 그 릴리스의 다이제스트와 메타 반환
 *
 * 릴리스 정보는 파일로 둔다(`releases/*.json`). 데이터베이스를 쓰지 않는 이유는,
 * 이 데이터가 릴리스할 때만 바뀌고 사람이 눈으로 검토해야 하는 값이기 때문이다 —
 * git 에 올려 리뷰하고 되돌릴 수 있는 편이 낫다.
 *
 * env: PORT, RELEASES_DIR, CUSTOMERS_FILE, NOTIKIT_LICENSE_PUBLIC_KEY(_FILE)
 */
import { createServer } from "node:http";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { verifyLicense } from "@notikit/license";

const PORT = Number(process.env.PORT ?? 8080);
const RELEASES_DIR = process.env.RELEASES_DIR ?? path.join(import.meta.dirname, "releases");
const CUSTOMERS_FILE = process.env.CUSTOMERS_FILE ?? path.join(import.meta.dirname, "customers.json");
/** CI 가 릴리스를 등록할 때 쓰는 토큰. 고객 라이선스와 전혀 다른 자격이다. */
const PUBLISH_TOKEN = process.env.PUBLISH_TOKEN ?? "";

const PUBLIC_KEY = process.env.NOTIKIT_LICENSE_PUBLIC_KEY_FILE
  ? readFileSync(process.env.NOTIKIT_LICENSE_PUBLIC_KEY_FILE, "utf8")
  : (process.env.NOTIKIT_LICENSE_PUBLIC_KEY ?? "").replace(/\\n/g, "\n");

if (!PUBLIC_KEY) {
  console.error("[update-server] NOTIKIT_LICENSE_PUBLIC_KEY(_FILE) is required");
  process.exit(1);
}

/** 파일은 릴리스·계약 변경 때만 바뀐다. 매 요청 디스크를 치지 않되, 재시작 없이 반영되게. */
const CACHE_MS = 30_000;
let cache = null;

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cmp(a, b) {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

async function loadCatalog() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const releases = [];
  let files = [];
  try {
    files = (await readdir(RELEASES_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    console.warn(`[update-server] no releases directory at ${RELEASES_DIR}`);
  }
  for (const f of files) {
    try {
      const r = JSON.parse(await readFile(path.join(RELEASES_DIR, f), "utf8"));
      // 다이제스트 없는 릴리스는 내보내지 않는다. 태그만으로는 무엇을 받을지 고정되지 않는다.
      if (!semver(r.version) || !/^sha256:[a-f0-9]{64}$/.test(r.digest ?? "")) {
        console.warn(`[update-server] skipping malformed release ${f}`);
        continue;
      }
      releases.push(r);
    } catch (err) {
      console.warn(`[update-server] skipping unreadable release ${f}:`, err.message);
    }
  }
  releases.sort((a, b) => cmp(a.version, b.version));

  let customers = {};
  try {
    customers = JSON.parse(await readFile(CUSTOMERS_FILE, "utf8"));
  } catch {
    // 고객별 예외가 없으면 모두 라이선스의 채널을 따른다
  }

  const value = { releases, customers };
  cache = { at: Date.now(), value };
  return value;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function bearer(req) {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : "";
}

/**
 * 이 고객에게 줄 최신 릴리스.
 *
 * 고객별 `pin` 이 있으면 그 버전에 묶는다 — 검증이 끝난 버전에 세워 두거나, 사고가
 * 난 릴리스에서 특정 고객만 잡아 두기 위해서다. 그런 수단이 없으면 문제가 생겼을 때
 * 할 수 있는 일이 "모두에게 배포를 멈추는 것"뿐이다.
 */
function resolve(catalog, license, requestedChannel) {
  const override = catalog.customers[license.customerId] ?? {};
  if (override.blocked) return null;

  const channel = override.channel ?? requestedChannel ?? license.channel ?? "stable";
  const eligible = catalog.releases.filter((r) => (r.channel ?? "stable") === channel && !r.yanked);
  if (eligible.length === 0) return null;

  if (override.pin) return eligible.find((r) => cmp(r.version, override.pin) === 0) ?? null;
  return eligible[eligible.length - 1];
}

/** 토큰 비교는 길이·내용이 새지 않게 상수 시간으로 */
function timingSafeEqualStr(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** CI 가 보낸 매니페스트를 파일로 떨군다. 형식이 어긋나면 받지 않는다. */
async function publish(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, { error: "Invalid JSON" });
  }

  if (!semver(body.version)) return json(res, 400, { error: "version must be semver" });
  // 다이제스트가 없으면 고객이 무엇을 받을지 고정되지 않는다. 여기서 막는다.
  if (!/^sha256:[a-f0-9]{64}$/.test(body.digest ?? "")) return json(res, 400, { error: "digest required" });
  if (!/^[a-z0-9.\-_/:]+$/i.test(body.image ?? "")) return json(res, 400, { error: "image required" });

  const file = path.join(RELEASES_DIR, `${body.version}.json`);
  await mkdir(RELEASES_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(body, null, 2) + "\n", "utf8");
  cache = null; // 다음 조회부터 즉시 보이게

  console.log(`[update-server] published ${body.version} (${body.channel ?? "stable"})`);
  return json(res, 201, { published: body.version });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") return json(res, 200, { status: "ok" });

  // 릴리스 등록 — CI 전용. 고객 라이선스로는 절대 들어올 수 없다.
  if (url.pathname === "/v1/releases" && req.method === "POST") {
    if (!PUBLISH_TOKEN) return json(res, 503, { error: "Publishing is not configured" });
    if (!timingSafeEqualStr(bearer(req), PUBLISH_TOKEN)) return json(res, 403, { error: "Forbidden" });
    return publish(req, res);
  }

  if (url.pathname !== "/v1/releases/latest") return json(res, 404, { error: "Not found" });
  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });

  const result = verifyLicense(bearer(req), PUBLIC_KEY);
  if (result.status === "missing") return json(res, 401, { error: "License required" });
  if (result.status === "invalid") return json(res, 403, { error: "License invalid" });
  // 만료는 403 이다. 인스턴스는 이걸 받고 "업데이트만" 막는다 — 서비스는 계속 돈다.
  if (result.status === "expired") return json(res, 403, { error: "License expired", expiresAt: result.license.expiresAt });

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    console.error("[update-server] catalog failed:", err);
    return json(res, 503, { error: "Catalog unavailable" });
  }

  const release = resolve(catalog, result.license, url.searchParams.get("channel"));
  if (!release) return json(res, 204, {});

  console.log(
    `[update-server] ${result.license.customerId} @ ${req.headers["x-notikit-version"] ?? "?"} → ${release.version}`
  );

  return json(res, 200, {
    version: release.version,
    image: release.image,
    digest: release.digest,
    notes: release.notes ?? "",
    hasMigrations: release.hasMigrations === true,
    minUpgradeFrom: release.minUpgradeFrom ?? null,
    publishedAt: release.publishedAt ?? null,
  });
});

server.listen(PORT, () => console.log(`[update-server] listening on :${PORT}`));
