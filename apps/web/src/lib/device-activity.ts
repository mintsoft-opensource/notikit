import { sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { deviceActivity } from "@/db/schema";

type Db = ReturnType<typeof getDb>;

/**
 * 접속 기록 — (디바이스, UTC 날짜) 하루당 한 행으로 접는다.
 *
 * 한계: 한 기기를 하루에 두 사람이 쓰면 먼저 기록된 유저만 남는다. 활성 유저가
 * 과소집계될 수는 있어도 **지워지지는 않는다**(coalesce). 정확히 세려면 행을
 * (device, day, user) 로 쪼개야 하는데, 익명 접속이 NULL 이라 유니크가 깨진다.
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
        // 익명 접속(로그아웃 상태)이 그 날 기록된 유저를 지우지 않게 한다.
        // 덮어쓰면 Alice 가 쓰고 로그아웃한 날의 활성 유저가 0 이 된다.
        userId: sql`coalesce(${deviceActivity.userId}, ${device.userId ?? null})`,
        platform: device.platform,
      },
    });
}
