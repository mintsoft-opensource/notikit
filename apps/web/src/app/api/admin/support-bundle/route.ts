import { desc, sql as raw } from "drizzle-orm";
import { getDb } from "@/db/client";
import { updateJobs } from "@/db/schema";
import { fail } from "@/lib/api-response";
import { getAuthContext } from "@/lib/authz";
import { isInstanceOperator } from "@/lib/instance-operator";
import { licenseSummary } from "@/lib/license";
import { CURRENT_VERSION } from "@/lib/updates";

export const dynamic = "force-dynamic";

/**
 * 지원 번들 — 온프렘 장애를 전화로 더듬지 않기 위한 것.
 *
 * 고객사 박스에는 우리가 들어갈 수 없다. 무엇이 어떤 상태인지 물어보는 것으로
 * 30분을 쓰는 대신, 파일 하나를 받는다.
 *
 * **비밀은 절대 담지 않는다.** 어떤 설정이 "채워져 있는지"만 알려 준다. 지원 번들은
 * 메일과 메신저를 타고 돌아다니게 되어 있어서, 값이 하나라도 들어가면 그 순간
 * 유출 경로가 된다.
 */

/** 존재 여부만 확인할 설정. 값은 절대 읽지 않는다. */
const CONFIG_PRESENCE = [
  "DATABASE_URL",
  "REDIS_URL",
  "ADMIN_TOKEN",
  "NOTIKIT_ENCRYPTION_KEY",
  "NOTIKIT_LICENSE_KEY",
  "NOTIKIT_LICENSE_PUBLIC_KEY",
  "NOTIKIT_UPDATE_SERVER",
  "NOTIKIT_SELF_UPDATE",
  "APP_ORIGIN",
  "TRUSTED_PROXY_HOPS",
  "WORKER_BASE_URL",
] as const;

export async function GET(req: Request) {
  const ctx = await getAuthContext(req);
  if (!ctx) return fail("Unauthorized", 401);
  // 설치 전체의 상태가 담긴다. 고객사 소유자가 아니라 운영자만 가져갈 수 있다.
  if (!(await isInstanceOperator(ctx))) return fail("Forbidden: 인스턴스 운영자만 받을 수 있습니다", 403, { code: "instance_operator_only" });

  const db = getDb();

  const [migrations, counts, jobs] = await Promise.all([
    // 적용된 마이그레이션 — 스키마가 코드보다 뒤처졌는지 판단하는 근거
    db
      .execute(
        raw`select hash, created_at from drizzle.__drizzle_migrations order by created_at desc limit 20`
      )
      .catch(() => []),
    db
      .execute(
        raw`select
              (select count(*) from organizations) as orgs,
              (select count(*) from projects) as projects,
              (select count(*) from devices) as devices,
              (select count(*) from push_logs where created_at > now() - interval '24 hours') as sends_24h,
              (select count(*) from push_logs where status = 'queued') as queued`
      )
      .catch(() => []),
    db.select().from(updateJobs).orderBy(desc(updateJobs.createdAt)).limit(10).catch(() => []),
  ]);

  const bundle = {
    generatedAt: new Date().toISOString(),
    version: CURRENT_VERSION,
    license: licenseSummary(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      uptimeSec: Math.round(process.uptime()),
      memoryRssBytes: process.memoryUsage().rss,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    // 값이 아니라 "설정되었는가"만. 이 파일은 돌아다닌다.
    config: Object.fromEntries(
      CONFIG_PRESENCE.map((k) => [k, process.env[k] ? "set" : "unset"])
    ),
    migrations: Array.isArray(migrations) ? migrations : [],
    counts: Array.isArray(counts) ? counts[0] : null,
    // 로그 본문에 호스트명·경로가 섞일 수 있지만 비밀은 없다. 실패 원인이 여기 있다.
    updates: (Array.isArray(jobs) ? jobs : []).map((j) => ({
      ...j,
      log: typeof j.log === "string" ? j.log.slice(-20_000) : "",
    })),
  };

  const name = `notikit-support-${CURRENT_VERSION}-${new Date().toISOString().slice(0, 10)}.json`;
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
}
