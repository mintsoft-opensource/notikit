import { and, eq, gt, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, projects } from "@/db/schema";
import { decryptSecret } from "@/lib/keys";
import { parseServiceAccount } from "@/lib/firebase-credentials";
import { sendToTokens } from "@/lib/fcm";

const PAGE = 2000;
const BATCH = 500; // FCM 멀티캐스트 한도
const CONCURRENCY = 4;

export interface TokenHealthResult {
  checked: number;
  invalid: number;
  deactivated: number;
  /** 크레덴셜이 없어 검사 자체를 못한 경우 */
  skipped: boolean;
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
 * 한계: FCM 에 등록된 토큰인지까지만 알 수 있다. 앱이 지워졌는데 토큰이 아직
 * 만료되지 않았다면 여기서는 유효하게 보인다. 확정적인 신호는 실제 발송의 응답이다.
 */
export async function checkProjectTokens(projectId: string): Promise<TokenHealthResult> {
  const db = getDb();
  const project = (await db.select().from(projects).where(eq(projects.id, projectId)).limit(1))[0];
  if (!project?.firebaseCredentialsEnc) {
    return { checked: 0, invalid: 0, deactivated: 0, skipped: true };
  }
  const sa = parseServiceAccount(decryptSecret(project.firebaseCredentialsEnc));

  let checked = 0;
  const invalidAll: string[] = [];

  // keyset 페이지네이션 — 대량 프로젝트에서 전체 토큰을 메모리에 올리지 않는다
  let cursor = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const rows = await db
      .select({ id: devices.id, token: devices.token })
      .from(devices)
      .where(and(eq(devices.projectId, projectId), eq(devices.isActive, true), gt(devices.id, cursor)))
      .orderBy(devices.id)
      .limit(PAGE);
    if (rows.length === 0) break;

    const tokens = rows.map((r) => r.token);
    checked += tokens.length;

    const results = await mapLimit(chunk(tokens, BATCH), CONCURRENCY, (b) =>
      // dry-run 은 배달되지 않으므로 내용은 보이지 않는다. 다만 빈 페이로드로 검증이
      // 거부될 여지를 없애려고 마커 한 개를 실어 보낸다.
      sendToTokens(projectId, sa, b, { title: "", body: "", data: { notikit_check: "1" } }, true)
    );
    for (const r of results) invalidAll.push(...r.invalidTokens);

    cursor = rows[rows.length - 1].id;
    if (rows.length < PAGE) break;
  }

  let deactivated = 0;
  for (const c of chunk(invalidAll, 1000)) {
    const res = await db
      .update(devices)
      .set({ isActive: false })
      .where(and(eq(devices.projectId, projectId), inArray(devices.token, c)))
      .returning({ id: devices.id });
    deactivated += res.length;
  }

  return { checked, invalid: invalidAll.length, deactivated, skipped: false };
}
