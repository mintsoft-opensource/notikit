import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { pushClicks, pushConversions, pushLogs } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject } from "@/lib/authz";
import { conversionLift } from "@/lib/holdout";

export const dynamic = "force-dynamic";

/**
 * 발송 로그 단건 — 상세 화면용.
 *
 * 조회에 `projectId` 를 함께 건다. id 만으로 찾으면 다른 프로젝트의 발송 내용을
 * id 추측만으로 읽을 수 있다 — 제목·본문·대상이 그대로 들어 있다.
 *
 * 컬럼을 **명시해서** 고른다. `select()` 로 전체 행을 주면 `lock_token`(워커 펜싱용
 * 내부 값)까지 함께 나간다. 화면에 쓸 이유가 없는 값은 내보내지 않는다.
 */
const columns = {
  id: pushLogs.id,
  type: pushLogs.type,
  target: pushLogs.target,
  title: pushLogs.title,
  body: pushLogs.body,
  data: pushLogs.data,
  deepLink: pushLogs.deepLink,
  imageUrl: pushLogs.imageUrl,
  isTest: pushLogs.isTest,
  status: pushLogs.status,
  totalCount: pushLogs.totalCount,
  successCount: pushLogs.successCount,
  failureCount: pushLogs.failureCount,
  // 단말 수신 보고 수. FCM 접수(successCount)와 **다른 칸**이다 — 접수는 기기가 꺼져 있어도 성공한다.
  deliveredCount: pushLogs.deliveredCount,
  readCount: pushLogs.readCount,
  scheduledAt: pushLogs.scheduledAt,
  canceledAt: pushLogs.canceledAt,
  canceledBy: pushLogs.canceledBy,
  localTime: pushLogs.localTime,
  // 로케일별 문구와 **폴백 관측**. 폴백 수를 숨기면 "번역을 넣었다"는 믿음만 남는다.
  localeVariants: pushLogs.localeVariants,
  localeFallbacks: pushLogs.localeFallbacks,
  holdoutPercent: pushLogs.holdoutPercent,
  holdoutCount: pushLogs.holdoutCount,
  // 캠페인별 재정의 — 이 발송이 프로젝트 설정 중 무엇을 덮었는지
  ignoreQuietHours: pushLogs.ignoreQuietHours,
  maxSendsPerMinute: pushLogs.maxSendsPerMinute,
  variants: pushLogs.variants,
  variantStats: pushLogs.variantStats,
  // A/B 자동 승자 설정·판정 — 상세 화면이 "왜 승자가 없는지"를 말할 수 있는 유일한 값이다
  abTest: pushLogs.abTest,
  kakaoFallback: pushLogs.kakaoFallback,
  kakaoCount: pushLogs.kakaoCount,
  audienceUserCount: pushLogs.audienceUserCount,
  audienceDeviceCount: pushLogs.audienceDeviceCount,
  clickCount: pushLogs.clickCount,
  clickUserCount: pushLogs.clickUserCount,
  sentBy: pushLogs.sentBy,
  options: pushLogs.options,
  // 토큰별 실패 사유별 건수 — 상세 화면이 "왜 실패했는지"를 보여 주는 유일한 값이다
  deliveryErrors: pushLogs.deliveryErrors,
  createdAt: pushLogs.createdAt,
};

/** 전환 이름별 상위 몇 개까지 보여 줄지 — 표가 아니라 요약 카드라 길어지면 읽히지 않는다 */
const CONVERSION_NAMES_SHOWN = 5;

export async function GET(req: Request, ctx: { params: Promise<{ id: string; logId: string }> }) {
  const { id, logId } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const db = getDb();
  const row = (
    await db
      .select(columns)
      .from(pushLogs)
      .where(and(eq(pushLogs.id, logId), eq(pushLogs.projectId, id)))
      .limit(1)
  )[0];
  if (!row) return fail("Not found", 404);

  // 로그가 이 프로젝트의 것임을 위에서 확인한 뒤에만 집계한다 — 없는 id 로 통계를 긁게 두지 않는다.
  const [variantClicks, conversionTotal, conversionNames] = await Promise.all([
    db
      .select({ variant: pushClicks.variant, clicks: sql<number>`count(*)::int` })
      .from(pushClicks)
      .where(and(eq(pushClicks.logId, logId), eq(pushClicks.projectId, id)))
      .groupBy(pushClicks.variant),
    db
      .select({
        holdout: pushConversions.holdout,
        count: sql<number>`count(*)::int`,
        valueCents: sql<number>`coalesce(sum(${pushConversions.valueCents}), 0)::int`,
      })
      .from(pushConversions)
      .where(and(eq(pushConversions.logId, logId), eq(pushConversions.projectId, id)))
      // 대조군 전환과 보낸 쪽 전환은 **같은 칸에 담지 않는다** — 섞으면 리프트가 거꾸로 나온다
      .groupBy(pushConversions.holdout),
    db
      .select({
        name: pushConversions.name,
        count: sql<number>`count(*)::int`,
        valueCents: sql<number>`coalesce(sum(${pushConversions.valueCents}), 0)::int`,
      })
      .from(pushConversions)
      .where(and(eq(pushConversions.logId, logId), eq(pushConversions.projectId, id), eq(pushConversions.holdout, false)))
      .groupBy(pushConversions.name)
      .orderBy(desc(sql`count(*)`), pushConversions.name)
      .limit(CONVERSION_NAMES_SHOWN),
  ]);

  const sentConv = conversionTotal.find((r) => !r.holdout);
  const heldConv = conversionTotal.find((r) => r.holdout);
  const holdoutConversions = { count: heldConv?.count ?? 0, valueCents: heldConv?.valueCents ?? 0 };

  return ok({
    log: row,
    // 변형이 없던 발송의 클릭은 variant 가 null 이다 — 0번으로 접어 넣지 않는다
    clicks: { byVariant: variantClicks },
    conversions: {
      count: sentConv?.count ?? 0,
      valueCents: sentConv?.valueCents ?? 0,
      byName: conversionNames,
    },
    /**
     * 대조군. `lift` 는 "보낸 쪽 전환율 / 대조군 전환율 - 1" — 대조군 전환율이 0 이면 비율이
     * 성립하지 않으므로 null 이다(0% 나 무한대로 적지 않는다).
     */
    holdout: {
      percent: row.holdoutPercent,
      devices: row.holdoutCount,
      conversions: holdoutConversions,
      // 발송군의 전환/분모도 함께 준다 — 화면이 두 **비율**을 나란히 놓을 수 있어야
      // 비교가 성립한다. 분모가 다른 건수 두 개만 주면 화면에서 비교할 방법이 없다.
      sent: { converted: sentConv?.count ?? 0, total: row.successCount },
      lift: conversionLift(
        { converted: sentConv?.count ?? 0, total: row.successCount },
        { converted: holdoutConversions.count, total: row.holdoutCount }
      ),
    },
  });
}
