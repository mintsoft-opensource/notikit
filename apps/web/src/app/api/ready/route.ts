import { NextResponse } from "next/server";
import { sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { compareSchema, readBundledJournal } from "@/lib/schema-version";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

function unready(reason: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ status: "unready", reason, ...extra }, { status: 503, headers: NO_STORE });
}

/**
 * readiness — `/api/health` 와 다르다.
 *
 * `/api/health` 는 liveness 다: 프로세스가 살아 있는가. DB 가 죽어도 200 이고,
 * 그게 맞다(재시작해도 DB 는 안 살아난다).
 *
 * 이건 **트래픽을 받아도 되는가**를 본다. 업데이트 교체 후 이 엔드포인트가 통과해야
 * 성공으로 친다 — liveness 만 보면 스키마가 안 맞거나 DB 에 못 붙는 인스턴스도
 * "정상 업데이트"로 기록된다. 그래서 DB 왕복에 더해 **적용된 마이그레이션이 이 이미지의
 * 저널에 닿았는지**까지 본다.
 */
export async function GET() {
  let expected: number;
  try {
    expected = await readBundledJournal();
  } catch (err) {
    console.error("[ready] migration journal unreadable:", err);
    return unready("migration journal unreadable");
  }

  let applied: string | null;
  try {
    // 테이블부터 확인한다. 한 번도 migrate 되지 않은 DB 에서 바로 max() 를 읽으면
    // "relation does not exist" 로 던져 DB 장애와 구분되지 않는다(쿼리 안의 CASE 로는
    // 못 피한다 — 존재하지 않는 테이블은 분석 단계에서 이미 실패한다).
    // 첫 왕복이 커넥션·인증·네트워크까지 함께 검증한다.
    const db = getDb();
    const [table] = (await db.execute(
      raw`select to_regclass('drizzle.__drizzle_migrations')::text as name`
    )) as unknown as { name: string | null }[];
    if (!table?.name) {
      applied = null;
    } else {
      const [row] = (await db.execute(
        raw`select max(created_at)::text as applied from drizzle.__drizzle_migrations`
      )) as unknown as { applied: string | null }[];
      applied = row?.applied ?? null;
    }
  } catch (err) {
    console.error("[ready] database unreachable:", err);
    return unready("database unreachable");
  }

  const schema = compareSchema(applied, expected);
  if (!schema.ok) {
    console.error(`[ready] schema behind: applied=${schema.applied ?? "none"} expected=${schema.expected}`);
    return unready(schema.reason, { applied: schema.applied, expected: schema.expected });
  }

  return NextResponse.json(
    { status: "ready", service: "notikit-web", ts: new Date().toISOString() },
    { headers: NO_STORE }
  );
}
