import { asc } from "drizzle-orm";
import { getDb } from "@/db/client";
import { organizations } from "@/db/schema";
import type { AuthContext } from "@/lib/authz";

/**
 * 이 설치를 **운영하는 사람**인가 — 조직 소유자와 다르다.
 *
 * 멀티테넌트로 서비스하면 `role === "owner"` 는 고객사 소유자다. 그 사람이 인스턴스
 * 전체를 재시작할 수 있으면 안 된다. 운영자는 이 박스를 세운 사람, 즉 부트스트랩
 * 조직(가장 먼저 만들어진 org)의 소유자이거나 ADMIN_TOKEN 을 쥔 쪽이다.
 *
 * 그리고 기능 자체가 기본으로 꺼져 있다. 호스팅 서비스에서는 배포를 CI 가 하지,
 * 콘솔 버튼이 하지 않는다 — 켜는 것은 셀프호스트 운영자의 선택이어야 한다.
 */
export function selfUpdateEnabled(): boolean {
  return process.env.NOTIKIT_SELF_UPDATE === "true";
}

export async function isInstanceOperator(ctx: AuthContext): Promise<boolean> {
  if (ctx.superadmin) return true;
  if (ctx.role !== "owner" || !ctx.orgId) return false;

  // 부트스트랩 조직 = 가장 먼저 생성된 org. 셀프호스트에서는 org 가 하나뿐이라
  // 자연히 운영자와 일치하고, 서비스 운영 중에는 고객사가 여기 해당할 수 없다.
  const first = (
    await getDb().select({ id: organizations.id }).from(organizations).orderBy(asc(organizations.createdAt)).limit(1)
  )[0];
  return !!first && first.id === ctx.orgId;
}
