import { sql } from "drizzle-orm";
import type { getDb } from "@/db/client";
import type { ClientIp } from "@/lib/client-ip";

type Db = ReturnType<typeof getDb>;

/**
 * IP → ISO 3166-1 국가 코드.
 *
 * 구간 테이블에서 "시작 IP 가 대상 이하인 것 중 가장 큰 것"을 잡고 끝 IP 로 확인한다.
 * (family, start_ip) 인덱스 역방향 스캔 한 번으로 끝난다 — 등록/핑 경로에 있어도
 * 부담이 없다(측정: 0.03ms, 4페이지).
 *
 * family 로 먼저 거르는 이유: Postgres 는 inet 비교에서 IPv4 를 IPv6 앞에 놓는다.
 * 필터가 없으면 IPv6 조회가 "더 작은" IPv4 구간을 잘못 집는다.
 */
export async function countryForIp(db: Db, client: ClientIp): Promise<string | null> {
  try {
    // **선행 구간 하나만** 집은 뒤 포함 여부를 확인한다.
    //
    // end_ip 조건을 바깥 WHERE 에 두면 LIMIT 전에 평가돼, 어느 구간에도 속하지 않는
    // 주소(사설 대역 등)에서 인덱스를 앞쪽으로 계속 훑는다. 측정값 52ms — 정상
    // 경로(0.03ms)의 1700배이고, 이 조회는 등록·핑 요청마다 돈다.
    const rows = await db.execute<{ country_code: string }>(sql`
      select country_code from (
        select country_code, end_ip
        from ip_country_ranges
        where family = ${client.family} and start_ip <= ${client.ip}::inet
        order by start_ip desc
        limit 1
      ) c
      where c.end_ip >= ${client.ip}::inet
    `);
    return rows[0]?.country_code ?? null;
  } catch {
    // 판정 실패가 디바이스 등록을 막으면 안 된다. 국가는 비워두고 진행한다.
    return null;
  }
}
