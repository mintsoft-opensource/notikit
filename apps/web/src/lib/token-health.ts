import { and, eq, gt, inArray, isNull, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, projects } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";
import { recordUninstalls } from "@/lib/device-events";

const PAGE = 2000;
const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 4;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * 양의 정수 env 파싱. `??` 는 빈 문자열을 잡지 못해 `Number("") === 0` 이 되고,
 * MAX_PER_RUN 이 0 이면 매번 아무것도 검사하지 않은 채 partial 로 남아 영구히 멈춘다.
 */
function positiveEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 한 번의 호출에서 검사할 최대 토큰 수. 넘으면 커서를 저장하고 다음 호출에서 이어 돈다. */
const MAX_PER_RUN = positiveEnv("TOKEN_CHECK_MAX_PER_RUN", 50_000);
/** 진행 중 스윕의 리스 — 워커가 죽어도 이 시간이 지나면 다른 워커가 이어받는다. */
const LEASE_MS = positiveEnv("TOKEN_CHECK_LEASE_MS", 5 * 60_000);

export interface TokenHealthResult {
  checked: number;
  invalid: number;
  deactivated: number;
  /** 크레덴셜이 없어 검사 자체를 못한 경우 */
  skipped: boolean;
  /** 최근에 이미 검사되어 이번 호출은 건너뛴 경우(야간 스윕 중복 방지) */
  alreadyChecked?: boolean;
  /** 상한에 걸려 아직 남았다 — 호출자가 이어서 한 번 더 불러야 한다 */
  partial?: boolean;
  /** FCM 이 무효 판정이 아닌 오류를 낸 토큰 수 — 검사되지 않았다 */
  unverified?: number;
  /** 리스가 만료되어 다른 워커가 이어받았다 — 이번 결과는 기록하지 않았다 */
  leaseLost?: boolean;
}

interface Claim {
  ok: boolean;
  cursor: string;
  /** 이 클레임의 소유권 증표. 최종 기록 시 이 값이 그대로 남아 있을 때만 쓴다. */
  lease: Date;
}

/**
 * 스윕 수행권 획득. 조건부 UPDATE 한 번이라 워커가 여러 대여도 한 대만 이긴다
 * (인메모리 레이트리밋은 인스턴스 간에 공유되지 않아 여기선 쓸 수 없다).
 *
 * - 신규 시작(커서 null): 마지막 완주가 minIntervalHours 보다 오래됐고, 리스도 비어 있을 때
 * - 이어받기(커서 존재): 리스가 비었거나(정상적으로 한 구간을 마침) 만료됐을 때(워커 사망)
 *
 * 두 워커가 동시에 들어와도 Postgres 가 행 잠금으로 직렬화하므로, 먼저 커밋한 쪽이
 * 리스를 채우고 나머지는 조건이 깨져 실패한다.
 */
async function claimSweep(projectId: string, minIntervalHours: number): Promise<Claim> {
  const db = getDb();
  const now = Date.now();
  const freshCutoff = new Date(now - minIntervalHours * 3_600_000);
  const leaseCutoff = new Date(now - LEASE_MS);
  const leaseFree = or(isNull(projects.tokensSweepLeaseAt), lt(projects.tokensSweepLeaseAt, leaseCutoff));

  const lease = new Date();
  const claimed = await db
    .update(projects)
    .set({ tokensSweepLeaseAt: lease })
    .where(
      and(
        eq(projects.id, projectId),
        or(
          and(
            isNull(projects.tokensCheckCursor),
            or(isNull(projects.tokensCheckedAt), lt(projects.tokensCheckedAt, freshCutoff)),
            leaseFree
          ),
          and(isNotNull(projects.tokensCheckCursor), leaseFree)
        )
      )
    )
    .returning({ cursor: projects.tokensCheckCursor });

  if (claimed.length === 0) return { ok: false, cursor: ZERO_UUID, lease };
  return { ok: true, cursor: claimed[0].cursor ?? ZERO_UUID, lease };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.all(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * 죽은 토큰 청소 — FCM dry-run(validate_only)으로 활성 토큰을 검증하고,
 * 등록 해제된 토큰을 비활성화한다.
 *
 * dry-run 은 FCM 이 **검증만 하고 배달하지 않으므로** 유저에게 알림이 뜨지 않는다.
 * 실제 발송으로 토큰을 확인하려 들면 무의미한 알림을 전부에게 쏘게 된다.
 *
 * 토큰이 많으면 MAX_PER_RUN 에서 끊고 커서를 저장한다(partial: true).
 * 한 번에 끝까지 돌면 스윕 창을 넘겨 낮까지 이어지고, 그 사이 워커 재시작은
 * 처음부터 다시 돌게 만든다.
 *
 * 한계: FCM 에 등록된 토큰인지까지만 알 수 있다. 앱이 지워졌는데 토큰이 아직
 * 만료되지 않았다면 여기서는 유효하게 보인다. 확정적인 신호는 실제 발송의 응답이다.
 */
export async function checkProjectTokens(
  projectId: string,
  opts: { minIntervalHours?: number } = {}
): Promise<TokenHealthResult> {
  const db = getDb();

  // 클레임은 항상 거친다. 예전에는 파라미터가 없으면 클레임을 건너뛰고도 커서와 리스를
  // 덮어썼다 — 수동 호출이 진행 중인 야간 스윕의 진행 상황을 날릴 수 있었다.
  // minIntervalHours 0 = "간격 조건 없이 지금 실행"(수동), 단 리스는 여전히 존중한다.
  const claim = await claimSweep(projectId, opts.minIntervalHours ?? 0);
  if (!claim.ok) return { checked: 0, invalid: 0, deactivated: 0, skipped: false, alreadyChecked: true };
  let cursor = claim.cursor;

  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project?.firebaseCredentialsEnc) {
    // 크레덴셜이 없으면 이어 돌 것도 없다. tokensCheckedAt 도 찍어 둔다 —
    // 안 찍으면 스윕 창 내내 매 tick 마다 다시 클레임된다.
    await db
      .update(projects)
      .set({ tokensCheckCursor: null, tokensSweepLeaseAt: null, tokensCheckedAt: sql`now()` })
      .where(and(eq(projects.id, projectId), eq(projects.tokensSweepLeaseAt, claim.lease)));
    return { checked: 0, invalid: 0, deactivated: 0, skipped: true };
  }
  const sa = parseServiceAccount(decryptSecret(project.firebaseCredentialsEnc));

  let checked = 0;
  let partial = false;
  let unverified = 0;
  let deactivated = 0;
  let invalid = 0;

  /** 무효 토큰 비활성화 — **페이지마다 즉시** 반영한다. 루프 끝으로 미루면 중간에
   *  FCM 이 던졌을 때 그때까지 찾은 죽은 토큰이 전부 버려진다. */
  async function deactivate(tokens: string[]): Promise<void> {
    deactivated += await recordUninstalls(db, projectId, tokens, "sweep");
  }

  // keyset 페이지네이션 — 대량 프로젝트에서 전체 토큰을 메모리에 올리지 않는다
  for (;;) {
    const remaining = MAX_PER_RUN - checked;
    if (remaining <= 0) {
      partial = true;
      break;
    }

    const want = Math.min(PAGE, remaining);
    const rows = await db
      .select({ id: devices.id, token: devices.token })
      .from(devices)
      .where(and(eq(devices.projectId, projectId), eq(devices.isActive, true), gt(devices.id, cursor)))
      .orderBy(devices.id)
      .limit(want);
    if (rows.length === 0) break;

    const tokens = rows.map((r) => r.token);

    let results;
    try {
      results = await mapLimit(chunk(tokens, BATCH), CONCURRENCY, (b) =>
        // dry-run 은 배달되지 않으므로 내용은 보이지 않는다. 다만 빈 페이로드로 검증이
        // 거부될 여지를 없애려고 마커 한 개를 실어 보낸다.
        sendToTokens(projectId, sa, b, { title: "", body: "", data: { notikit_check: "1" } }, true)
      );
    } catch {
      // FCM 장애 — 이 페이지는 검사하지 못했다. 커서를 넘기지 않고 여기서 멈춰
      // 다음 호출이 같은 지점부터 재시도하게 한다.
      unverified += tokens.length;
      partial = true;
      break;
    }

    checked += tokens.length;
    const pageInvalid: string[] = [];
    let pageFailed = 0;
    for (const r of results) {
      pageInvalid.push(...r.invalidTokens);
      // 무효 판정이 아닌 실패(쿼터·일시 장애)는 "검사 못 함"이다
      pageFailed += r.failure - r.invalidTokens.length;
    }
    invalid += pageInvalid.length;
    await deactivate(pageInvalid);

    cursor = rows[rows.length - 1].id;

    if (pageFailed > 0) {
      // 남은 구간은 다음 호출로 넘긴다 — 완주로 찍어 다음 창까지 건너뛰지 않게
      unverified += pageFailed;
      partial = true;
      break;
    }
    if (rows.length < want) break; // 요청한 만큼 못 받았으면 더 없다
  }

  // MAX_PER_RUN 에 정확히 걸린 경우 실제로 남았는지 1행만 확인한다 —
  // 안 하면 남은 게 없는데도 partial 로 보고해 불필요한 왕복이 한 번 생긴다
  if (partial && unverified === 0) {
    const more = await db
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.projectId, projectId), eq(devices.isActive, true), gt(devices.id, cursor)))
      .limit(1);
    if (more.length === 0) partial = false;
  }

  // fencing: 리스가 만료되어 다른 워커가 이어받았다면 우리 커서를 쓰면 안 된다.
  // 조건이 깨지면 0행이 갱신되고, 우리는 조용히 물러난다(이미 후임이 진행 중).
  const wrote = await db
    .update(projects)
    .set({
      tokensCheckCursor: partial ? cursor : null,
      tokensSweepLeaseAt: null,
      ...(partial ? {} : { tokensCheckedAt: sql`now()` }),
    })
    .where(and(eq(projects.id, projectId), eq(projects.tokensSweepLeaseAt, claim.lease)))
    .returning({ id: projects.id });

  return {
    checked,
    invalid,
    deactivated,
    skipped: false,
    partial: wrote.length === 0 ? false : partial,
    ...(unverified > 0 ? { unverified } : {}),
    ...(wrote.length === 0 ? { leaseLost: true } : {}),
  };
}
