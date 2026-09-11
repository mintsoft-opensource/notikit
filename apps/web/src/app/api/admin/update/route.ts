import { desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db/client";
import { updateJobs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { checkForUpdate, isNewer, CURRENT_VERSION } from "@/lib/updates";
import { isInstanceOperator, selfUpdateEnabled } from "@/lib/instance-operator";

export const dynamic = "force-dynamic";

/** 끝나지 않은 작업 상태 — 이 둘일 때만 업데이터가 손대고 있다 */
const ACTIVE = ["pending", "running"] as const;

/** [Web Admin] 현재 버전 / 사용 가능한 버전 / 진행 중이거나 마지막이었던 작업 */
export async function GET(req: Request) {
  const ctx = await getAuthContext(req);
  if (!ctx) return fail("Unauthorized", 401);

  const db = getDb();
  const [check, recent, operator] = await Promise.all([
    checkForUpdate(),
    db.select().from(updateJobs).orderBy(desc(updateJobs.createdAt)).limit(5),
    isInstanceOperator(ctx),
  ]);

  return ok({
    ...check,
    canUpdate: selfUpdateEnabled() && operator,
    active: recent.find((j) => (ACTIVE as readonly string[]).includes(j.status)) ?? null,
    history: recent,
  });
}

const startSchema = z.object({ target_version: z.string().min(1).max(64) });

/** [Web Admin] 업데이트 시작 — 행을 남기면 업데이터 사이드카가 집어 간다 */
export async function POST(req: Request) {
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

  const db = getDb();
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
        targetVersion: target,
        // 업데이터가 다시 조회하지 않게 여기 박는다. 두 번 물으면 그 사이에 답이
        // 바뀌어, 승인한 것과 다른 이미지가 설치될 수 있다.
        image: check.latest.image,
        digest: check.latest.digest,
        hasMigrations: check.latest.hasMigrations,
        requestedBy: ctx.userId,
      })
      .returning();
    return ok({ job });
  } catch {
    // 부분 유니크 인덱스가 동시 요청을 막는다 — 위 검사와 삽입 사이의 경합
    return fail("이미 진행 중인 업데이트가 있습니다", 409);
  }
}
