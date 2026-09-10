import { sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { deviceActivity } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * 접속 기록 — (디바이스, UTC 날짜) 하루당 한 행으로 접는다.
 *
 * 앱을 열 때마다 행을 쌓으면 감당이 안 되고, 반대로 devices.lastActiveAt 만 갱신하면
 * "마지막"만 남아 추이를 낼 수 없다. 그 사이가 이 롤업이다.
 *
 * 같은 날 재호출은 opens 만 올린다.
 */
export async function recordAccess(
  db: Db,
  projectId: string,
  device: { id: string; userId: string | null; platform: string }
): Promise<void> {
  await db
    .insert(deviceActivity)
    .values({
      projectId,
      deviceId: device.id,
      userId: device.userId,
      platform: device.platform,
      // UTC 날짜 — 서버 로컬시각을 쓰면 배포 지역에 따라 같은 데이터가 다르게 집계된다
      day: sql`(now() at time zone 'UTC')::date`,
      opens: 1,
    })
    .onConflictDoUpdate({
      target: [deviceActivity.deviceId, deviceActivity.day],
      set: {
        opens: sql`${deviceActivity.opens} + 1`,
        lastAt: sql`now()`,
        // 로그인/로그아웃으로 바뀔 수 있어 최신값으로 맞춘다
        userId: device.userId,
        platform: device.platform,
      },
    });
}
