import { and, eq, inArray } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { deviceEvents, devices } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * FCM 이 받아준 토큰을 검증 완료로 표시한다.
 * 등록 시점에는 토큰 진위를 알 수 없어, 실제 발송/dry-run 이 통과한 것만 신뢰한다.
 */
export async function markVerified(db: Db, projectId: string, tokens: string[]): Promise<void> {
  for (const c of chunk(tokens, 1000)) {
    await db
      .update(devices)
      .set({ verifiedAt: new Date() })
      .where(and(eq(devices.projectId, projectId), inArray(devices.token, c)));
  }
}

/**
 * 무효 토큰을 비활성화하고 **앱 삭제 이벤트로 기록**한다.
 *
 * 이미 비활성인 디바이스는 건너뛴다 — 스윕이 매일 같은 죽은 토큰을 다시 만나면
 * 삭제 이벤트가 날마다 중복 적재되어 삭제 추이가 부풀려진다.
 *
 * 반환값은 실제로 이번에 비활성화된 수(= 새로 감지한 삭제 수)다.
 */
export async function recordUninstalls(
  db: Db,
  projectId: string,
  tokens: string[],
  source: "send" | "sweep"
): Promise<number> {
  let count = 0;
  for (const c of chunk(tokens, 1000)) {
    // 활성 → 비활성 전이만 잡는다. RETURNING 으로 전이한 행만 받아 이벤트를 만든다.
    const flipped = await db
      .update(devices)
      .set({ isActive: false })
      .where(and(eq(devices.projectId, projectId), inArray(devices.token, c), eq(devices.isActive, true)))
      .returning({ id: devices.id, userId: devices.userId, platform: devices.platform });
    if (flipped.length === 0) continue;

    await db.insert(deviceEvents).values(
      flipped.map((d) => ({
        projectId,
        deviceId: d.id,
        userId: d.userId,
        platform: d.platform,
        event: "uninstalled" as const,
        source,
      }))
    );
    count += flipped.length;
  }
  return count;
}

/**
 * 비활성이던 디바이스가 다시 등록되면 재설치로 기록한다.
 * 호출부는 업서트 **직전**의 활성 여부를 알아야 하므로 wasInactive 를 넘긴다.
 */
export async function recordReinstall(
  db: Db,
  projectId: string,
  device: { id: string; userId: string | null; platform: string }
): Promise<void> {
  await db.insert(deviceEvents).values({
    projectId,
    deviceId: device.id,
    userId: device.userId,
    platform: device.platform,
    event: "reinstalled",
    source: "register",
  });
}
