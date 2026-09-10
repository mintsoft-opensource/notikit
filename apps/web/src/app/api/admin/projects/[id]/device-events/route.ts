import { and, desc, eq } from "drizzle-orm";
import { beforeCursor, cursorExpr, nextCursor, parseCursor } from "@/lib/keyset";
import { getDb } from "@/db/client";
import { deviceEvents, pushUsers } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";

export const dynamic = "force-dynamic";

const EVENTS = ["uninstalled", "reinstalled"] as const;
type Event = (typeof EVENTS)[number];
const LIMIT = 50;

/**
 * [Web Admin] 앱 삭제/재설치 로그.
 *
 * 삭제 판정은 FCM 이 토큰을 not-registered 로 돌려준 시점이라 **실제 삭제보다 늦다**.
 * source=send 는 실제 발송 응답, sweep 은 주기 검사로 감지한 것이다.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const url = new URL(req.url);
  const eventParam = url.searchParams.get("event");
  // 프로토타입 체인이 통과하지 않도록 명시적 허용 목록
  const event = EVENTS.includes(eventParam as Event) ? (eventParam as Event) : null;

  // keyset 커서 — offset 은 깊은 페이지에서 느려지고 새 이벤트가 들어오면 행이 밀린다.
  // (at, id) 복합인 이유는 keyset.ts 참조 — 무효토큰 정리가 한 문장에 1000행을 넣어
  // 같은 at 이 대량 발생한다.
  const cursor = parseCursor(url);

  const conds = [eq(deviceEvents.projectId, id)];
  if (event) conds.push(eq(deviceEvents.event, event));
  if (cursor) conds.push(beforeCursor(deviceEvents.at, deviceEvents.id, cursor));

  const db = getDb();
  const rows = await db
    .select({
      id: deviceEvents.id,
      event: deviceEvents.event,
      source: deviceEvents.source,
      platform: deviceEvents.platform,
      at: deviceEvents.at,
      cursorTs: cursorExpr(deviceEvents.at),
      externalId: pushUsers.externalId,
    })
    .from(deviceEvents)
    .leftJoin(pushUsers, eq(deviceEvents.userId, pushUsers.id))
    .where(and(...conds))
    .orderBy(desc(deviceEvents.at), desc(deviceEvents.id))
    .limit(LIMIT + 1);

  const hasMore = rows.length > LIMIT;
  const events = hasMore ? rows.slice(0, LIMIT) : rows;
  return ok({
    events: events.map(({ cursorTs: _cursorTs, ...e }) => e),
    next: nextCursor(events, hasMore),
  });
}
