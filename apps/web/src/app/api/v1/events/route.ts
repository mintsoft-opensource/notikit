import { and, desc, eq, gt, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushClicks, pushConversions, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimitShared, clientKey, principalKey } from "@/lib/rate-limit";
import { verifyIdentity } from "@/lib/keys";
import { onJourneyEvent } from "@/lib/journey-triggers";
import { errorMessage, log } from "@/lib/logger";
import {
  admitConversionName,
  attributionCutoff,
  conversionEventSchema,
  loadConversionNames,
  MAX_CONVERSION_NAMES_PER_PROJECT,
  recordConversionName,
} from "@/lib/conversions";
import { ok, fail } from "@/lib/api-response";

export const dynamic = "force-dynamic";

/** 테넌트 전체 상한 — 한 프로젝트가 인스턴스를 독점하지 못하게 하는 바깥 울타리 */
const PROJECT_LIMIT_PER_MIN = 20_000;
/**
 * 기기/사용자 하나가 분당 보고할 수 있는 전환 수.
 * 사람이 1분에 구매를 30번 하지는 않는다 — 정상 SDK 는 닿지 않고, 한 기기가 테넌트 버킷을
 * 통째로 소진해 **다른 모든 사용자의 보고를 429 로 만드는** 경로만 막힌다.
 */
const PRINCIPAL_LIMIT_PER_MIN = 30;

/**
 * 전환 이벤트 보고 (public: api-key).
 *
 * 앱에서 일어난 행동(구매·가입 등)을 **그 기기/사람이 최근 24시간 안에 클릭한 마지막 발송**에 붙인다.
 * 클릭이 없으면 귀속할 발송이 없으므로 저장하지 않고 202 로 끝낸다 — 푸시와 무관한 행동까지
 * 성과로 세면 전환 지표가 의미를 잃는다.
 *
 * 같은 (발송, 사람, 이름)은 하루 1건만 남는다(유니크). 앱이 재시도해도 매출이 부풀지 않는다.
 *
 * 공개 키만으로 열리는 쓰기 경로라 한도가 세 겹이다: 프로젝트 → 기기/사용자 → 이름 카디널리티.
 * 앞의 둘은 양(volume)을, 마지막은 집계 축이 무한히 늘어나는 것을 막는다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!(await rateLimitShared(clientKey(project.id, "events"), PROJECT_LIMIT_PER_MIN))) {
    return fail("Rate limit exceeded", 429);
  }

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = conversionEventSchema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  // user_id 는 공개 api-key 만으로 지목할 수 있으므로 **주체별 한도를 물리기 전에** 검증한다.
  // 예전에는 한도를 먼저 깎았다 — 그러면 api-key 만 쥔 쪽이 남의 external_id 를 위조해
  // 그 사람 버킷을 분당 30건으로 채워, **그 사용자의 전환 보고만 골라 429 로 막을 수 있었다**.
  // HMAC 검증은 DB 를 타지 않으므로, 앞으로 당겨도 "남용이 DB 까지 내려가지 않게" 한다는
  // 한도의 목적은 그대로다.
  if (b.external_id && (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc))) {
    return fail("identity_hash invalid or missing", 403);
  }

  // 여기부터 principal 은 **검증된 주체**다(토큰은 그 기기만 아는 값, user_id 는 서명으로 확인됨).
  const principal = b.token ?? (b.external_id as string);
  if (!(await rateLimitShared(principalKey(project.id, "events", principal), PRINCIPAL_LIMIT_PER_MIN))) {
    return fail("Rate limit exceeded", 429);
  }

  const db = getDb();

  // 대상 해석 — 토큰이면 그 기기의 클릭, user_id 면 그 사람의 모든 기기 클릭이 후보다
  let scope: SQL | undefined;
  /** 토큰으로 보낸 경우의 기기. 익명 전환의 유니크 키가 이 값으로 갈린다. */
  let deviceId: string | null = null;
  if (b.token) {
    const device = (
      await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
        .limit(1)
    )[0];
    if (!device) return fail("Device not found", 404);
    deviceId = device.id;
    scope = eq(pushClicks.deviceId, device.id);
  } else {
    const userId = b.external_id as string; // identity_hash 는 위에서 이미 검증했다
    const user = (
      await db
        .select({ id: pushUsers.id })
        .from(pushUsers)
        .where(and(eq(pushUsers.projectId, project.id), eq(pushUsers.externalId, userId)))
        .limit(1)
    )[0];
    if (!user) return fail("User not found", 404);
    scope = eq(pushClicks.userId, user.id);
  }

  // 저니 훅 — **인증·검증이 끝난 주체**에 대해서만 부른다(위조된 external_id 로 남의 저니를
  // 진행시킬 수 없다). 귀속 여부와 무관하게 여기서 부르는 이유: 전환은 최근 24시간 안에 누른
  // 발송이 있을 때만 저장되는데, 귀속되지 않은 행동도 "한 일"은 한 것이라 종료 조건은 봐야 한다.
  // 실패해도 이벤트 보고 자체는 성공시킨다 — 저니가 막혀서 SDK 의 전환 보고가 죽으면 안 된다.
  try {
    await onJourneyEvent(db, project.id, b.name, { deviceId, externalId: b.token ? null : (b.external_id as string) });
  } catch (e) {
    log.error("journey.event_hook_failed", { project_id: project.id, conversion_name: b.name, reason: errorMessage(e) });
  }

  const click = (
    await db
      .select({ logId: pushClicks.logId, userId: pushClicks.userId, deviceId: pushClicks.deviceId })
      .from(pushClicks)
      .where(and(eq(pushClicks.projectId, project.id), scope, gt(pushClicks.clickedAt, attributionCutoff())))
      .orderBy(desc(pushClicks.clickedAt))
      .limit(1)
  )[0];
  if (!click) return ok({ recorded: false, attributed: false }, undefined, 202);

  // 이름 상한은 여기서 본다 — 기기/사용자가 확인됐고 저장까지 갈 요청만 축을 건드리게.
  // 앞쪽(미검증 시점)에서 보면 공개 api-key 만으로 가짜 이름을 채워 넣어
  // 정상적인 새 이름을 전부 422 로 막을 수 있다.
  if (!(await admitConversionName(project.id, b.name, () => loadConversionNames(db, project.id)))) {
    return fail(`Too many distinct conversion names (limit ${MAX_CONVERSION_NAMES_PER_PROJECT} per project)`, 422);
  }

  const inserted = await db
    .insert(pushConversions)
    .values({
      projectId: project.id,
      logId: click.logId,
      userId: click.userId,
      // 익명(user_id null) 전환의 하루 1건 유니크는 기기로 갈린다 — 이 값이 비면
      // 서로 다른 익명 기기의 전환이 한 건으로 합쳐져 매출이 사라진다.
      // 토큰으로 보냈으면 그 기기, user_id 로 보냈으면 귀속된 클릭의 기기를 쓴다.
      deviceId: deviceId ?? click.deviceId,
      name: b.name,
      valueCents: b.value_cents ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: pushConversions.id });

  // DB 에 실제로 남은 이름만 축으로 센다 — 충돌(하루 1건 유니크)이면 이미 세어져 있다.
  if (inserted.length > 0) recordConversionName(project.id, b.name);

  return ok({ recorded: inserted.length > 0, attributed: true, message_id: click.logId }, undefined, 202);
}
