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
import { cmp, semver, isPublishableVersion, resolve, hasMigrationsSince } from "./catalog.mjs";

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

  // 이 값이 그대로 파일 이름이 된다. 끝 앵커가 없던 시절엔 `1.2.0/../../x` 가 통과해
  // RELEASES_DIR 밖에 JSON 을 쓸 수 있었다.
  if (!isPublishableVersion(body.version)) return json(res, 400, { error: "version must be semver (x.y.z[-pre])" });
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
  // 줄 릴리스가 없다(채널이 비었거나 이 고객 배포를 멈췄다). 예전엔 204 에 본문 `{}` 를 실어
  // 보냈고, 인스턴스는 그 본문을 파싱하다 실패해 "업데이트 서버에 연결할 수 없음"으로 보였다.
  // 200 + `latest: null` 로 "최신" 임을 분명히 한다.
  if (!release) return json(res, 200, { latest: null });

  const installed = req.headers["x-notikit-version"];
  console.log(`[update-server] ${result.license.customerId} @ ${installed ?? "?"} → ${release.version}`);

  return json(res, 200, {
    version: release.version,
    image: release.image,
    digest: release.digest,
    notes: release.notes ?? "",
    // 이 릴리스 하나가 아니라 설치본에서 여기까지 건너뛰는 구간 전체로 판정한다
    hasMigrations: hasMigrationsSince(catalog.releases, release, installed),
    minUpgradeFrom: release.minUpgradeFrom ?? null,
    publishedAt: release.publishedAt ?? null,
  });
});

server.listen(PORT, () => console.log(`[update-server] listening on :${PORT}`));
