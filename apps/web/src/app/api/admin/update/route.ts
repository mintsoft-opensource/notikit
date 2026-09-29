import { desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { updateJobs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { checkOrigin, getAuthContext } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { checkForUpdate, isNewer, CURRENT_VERSION } from "@/lib/updates";
import { isInstanceOperator, selfUpdateEnabled } from "@/lib/instance-operator";
import { licenseSummary } from "@/lib/license";
import { listBundles, findBundle } from "@/lib/airgap";

export const dynamic = "force-dynamic";

/** 끝나지 않은 작업 상태 — 이 둘일 때만 업데이터가 손대고 있다 */
const ACTIVE = ["pending", "running"] as const;

/** [Web Admin] 현재 버전 / 사용 가능한 버전 / 진행 중이거나 마지막이었던 작업 */
export async function GET(req: Request) {
  const ctx = await getAuthContext(req);
  if (!ctx) return fail("Unauthorized", 401);

  let check, recent, operator, bundles;
  try {
    // getDb() 도 안에 둔다 — DATABASE_URL 미설정/오타로 여기서 던지는데,
    // 그건 정확히 이 오류 경로가 존재하는 이유인 온프렘 설정 사고다.
    const db = getDb();
    [check, recent, operator, bundles] = await Promise.all([
      checkForUpdate(),
      db.select().from(updateJobs).orderBy(desc(updateJobs.createdAt)).limit(5),
      isInstanceOperator(ctx),
      listBundles(),
    ]);
  } catch (err) {
    // 원문은 서버에만 남긴다 — 이 엔드포인트는 운영자 전용이 아니라 admin 이면 누구나 읽는다.
    console.error("[update] status query failed:", err);
    return fail("서버 오류 — 로그에서 [update] 항목을 확인하세요", 500);
  }

  // 진행 상태는 누구나 봐도 되지만 백업 경로·업데이터 로그·레지스트리 주소는 아니다.
  // 여기서 걸러내지 않으면 **다른 고객사의 viewer** 가 우리 호스트 경로를 읽는다.
  const safeJob = (j: (typeof recent)[number]) => ({
    id: j.id,
    fromVersion: j.fromVersion,
    targetVersion: j.targetVersion,
    status: j.status,
    step: j.step,
    createdAt: j.createdAt,
    finishedAt: j.finishedAt,
  });

  return ok({
    ...check,
    canUpdate: selfUpdateEnabled() && operator,
    active: (() => {
      const a = recent.find((j) => (ACTIVE as readonly string[]).includes(j.status));
      if (!a) return null;
      return operator ? a : safeJob(a);
    })(),
    history: operator ? recent : recent.map(safeJob),
    // 라이선스 내역(고객사명·한도)과 반입 번들 목록(레지스트리 경로)은 운영자만.
    // 폐쇄망 설치에서 이 목록이 업데이트의 유일한 출처라 운영자에게는 반드시 준다.
    license: operator ? licenseSummary() : null,
    bundles: operator ? bundles : [],
  });
}

const startSchema = z.object({
  target_version: z.string().min(1).max(64),
  /** 폐쇄망 — 반입된 번들에서 설치한다. 지정하면 배포처에 묻지 않는다. */
  bundle: z.string().min(1).max(300).optional(),
});

/** [Web Admin] 업데이트 시작 — 행을 남기면 업데이터 사이드카가 집어 간다 */
export async function POST(req: Request) {
  // 쿠키로 인증되는 상태 변경이다 — 다른 사이트의 폼이 운영자 브라우저로 업데이트(재시작·마이그레이션)를
  // 시작하지 못하게 다른 쓰기 라우트와 같이 Origin 을 먼저 본다
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const ctx = await getAuthContext(req);
  if (!ctx) return fail("Unauthorized", 401);
  // 꺼져 있으면 존재를 알리지도 않는다 — 호스팅 배포에서 이 경로는 없는 것과 같다
  if (!selfUpdateEnabled()) return fail("Not found", 404);
  if (!(await isInstanceOperator(ctx))) return fail("Forbidden: 인스턴스 운영자만 업데이트할 수 있습니다", 403);

  let body: unknown;
  try {
    body = await readJsonLimited(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) return fail("Payload too large", 413);
    return fail("Invalid JSON", 400);
  }
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return fail("target_version is required", 400);

  const target = parsed.data.target_version.replace(/^v/, "");
  const db = getDb();

  // 폐쇄망 경로 — 배포처에 닿을 수 없는 설치다. 반입된 번들이 곧 승인 대상이며,
  // 무결성은 업데이터가 체크섬으로 다시 확인한다.
  if (parsed.data.bundle) {
    const bundle = await findBundle(parsed.data.bundle);
    if (!bundle) return fail("반입된 번들을 찾을 수 없습니다", 404);
    if (!bundle.verifiable) return fail("번들에 체크섬 파일(.sha256)이 없어 설치할 수 없습니다", 400);
    if (bundle.version !== target) return fail("번들의 버전이 요청한 버전과 다릅니다", 400);
    if (!isNewer(target, CURRENT_VERSION)) return fail("이미 최신 버전입니다", 409);

    return startJob(db, {
      target,
      image: bundle.image.split("@")[0],
      digest: bundle.digest,
      // 번들에는 마이그레이션 유무가 없다. 모르면 있다고 보고 백업을 뜬다 —
      // 틀렸을 때의 비용이 한쪽으로만 크다.
      hasMigrations: true,
      bundlePath: bundle.file,
      userId: ctx.userId,
    });
  }

  // 배포처가 지금 이 설치에 주기로 한 릴리스만 설치한다. 클라이언트가 버전을 고르게
  // 두면 만료된 구독이나 건너뛰면 안 되는 버전을 스스로 집어간다.
  const check = await checkForUpdate({ force: true });
  if (check.status === "unlicensed") return fail("구독이 유효하지 않아 업데이트할 수 없습니다", 402);
  if (!check.latest) return fail("업데이트 서버에 연결할 수 없습니다", 503);
  if (target !== check.latest.version) return fail("배포된 최신 릴리스만 설치할 수 있습니다", 400);
  if (!isNewer(target, CURRENT_VERSION)) return fail("이미 최신 버전입니다", 409);
  if (check.blockedBy) {
    return fail(`${check.blockedBy} 을(를) 먼저 설치해야 합니다 — 마이그레이션은 건너뛸 수 없습니다`, 409);
  }

  return startJob(db, {
    target,
    // 업데이터가 다시 조회하지 않게 여기 박는다. 두 번 물으면 그 사이에 답이
    // 바뀌어, 승인한 것과 다른 이미지가 설치될 수 있다.
    image: check.latest.image,
    digest: check.latest.digest,
    hasMigrations: check.latest.hasMigrations,
    bundlePath: null,
    userId: ctx.userId,
  });
}

type StartArgs = {
  target: string;
  image: string;
  digest: string;
  hasMigrations: boolean;
  bundlePath: string | null;
  userId: string | null;
};

async function startJob(db: ReturnType<typeof getDb>, args: StartArgs) {
  const active = await db
    .select({ id: updateJobs.id })
    .from(updateJobs)
    .where(inArray(updateJobs.status, [...ACTIVE]))
    .limit(1);
  if (active.length > 0) return fail("이미 진행 중인 업데이트가 있습니다", 409);

  try {
    const [job] = await db
      .insert(updateJobs)
      .values({
        fromVersion: CURRENT_VERSION,
        targetVersion: args.target,
        image: args.image,
        digest: args.digest,
        hasMigrations: args.hasMigrations,
        bundlePath: args.bundlePath,
        requestedBy: args.userId,
      })
      .returning();
    return ok({ job });
  } catch {
    // 부분 유니크 인덱스가 동시 요청을 막는다 — 위 검사와 삽입 사이의 경합
    return fail("이미 진행 중인 업데이트가 있습니다", 409);
  }
}
