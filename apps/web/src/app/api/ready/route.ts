import { NextResponse } from "next/server";
import { sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";

export const dynamic = "force-dynamic";

/**
 * readiness — `/api/health` 와 다르다.
 *
 * `/api/health` 는 liveness 다: 프로세스가 살아 있는가. DB 가 죽어도 200 이고,
 * 그게 맞다(재시작해도 DB 는 안 살아난다).
 *
 * 이건 **트래픽을 받아도 되는가**를 본다. 업데이트 교체 후 이 엔드포인트가 통과해야
 * 성공으로 친다 — liveness 만 보면 스키마가 안 맞거나 DB 에 못 붙는 인스턴스도
 * "정상 업데이트"로 기록된다.
 */
export async function GET() {
  try {
    // 가장 싼 왕복. 커넥션·인증·네트워크가 한 번에 검증된다.
    await getDb().execute(raw`select 1`);
  } catch (err) {
    console.error("[ready] database unreachable:", err);
    return NextResponse.json(
      { status: "unready", reason: "database unreachable" },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  return NextResponse.json(
    { status: "ready", service: "notikit-web", ts: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } }
  );
}
