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
    const rows = await db.execute<{ country_code: string }>(sql`
      select country_code
      from ip_country_ranges
      where family = ${client.family}
        and start_ip <= ${client.ip}::inet
        and end_ip >= ${client.ip}::inet
      order by start_ip desc
      limit 1
    `);
    return rows[0]?.country_code ?? null;
  } catch {
    // 판정 실패가 디바이스 등록을 막으면 안 된다. 국가는 비워두고 진행한다.
    return null;
  }
}
