import { sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { deviceActivity } from "@/db/schema";
import { clientIp, maskIp } from "@/lib/client-ip";
import { countryForIp } from "@/lib/geo";

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
  device: { id: string; userId: string | null; platform: string },
  /** 접속 위치 판정용. 넘기지 않으면 국가·IP 를 기록하지 않는다. */
  req?: Request
): Promise<void> {
  // 프록시 신뢰 설정이 없으면 clientIp 가 null 을 준다 — 위조 가능한 헤더로
  // 국가를 채우느니 비워둔다.
  const ip = req ? clientIp(req) : null;
  const country = ip ? await countryForIp(db, ip) : null;
  // 마스킹에 실패하면 저장하지 않는다(원본을 남기지 않는다)
  const ipMasked = ip ? maskIp(ip) : null;

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
      country,
      ipMasked,
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
        // 판정 실패(null)가 그 날 이미 기록된 위치를 지우지 않게 한다.
        // 같은 날 프록시 설정이 꺼졌다 켜져도 앞선 값이 남는다.
        country: sql`coalesce(${country ?? null}, ${deviceActivity.country})`,
        ipMasked: sql`coalesce(${ipMasked ?? null}, ${deviceActivity.ipMasked})`,
      },
    });
}
