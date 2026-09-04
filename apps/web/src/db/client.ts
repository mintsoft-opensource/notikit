import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  __notikitSql?: ReturnType<typeof postgres>;
};

/**
 * postgres-js 커넥션 풀 (전역 싱글턴 — 서버리스/HMR 에서 커넥션 폭주 방지).
 * ⚠️ 다중 인스턴스 프로덕션은 PgBouncer/관리형 풀러(Neon/RDS Proxy) 뒤에 두고 POOL_MAX 를 낮춘다.
 */
function getSql() {
  if (!globalForDb.__notikitSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__notikitSql = postgres(url, {
      max: Number(process.env.POOL_MAX ?? 10),
      idle_timeout: Number(process.env.POOL_IDLE_TIMEOUT ?? 20), // 초
      connect_timeout: Number(process.env.POOL_CONNECT_TIMEOUT ?? 10),
      prepare: false, // 외부 풀러(PgBouncer transaction mode) 호환
    });
  }
  return globalForDb.__notikitSql;
}

export function getDb() {
  return drizzle(getSql(), { schema });
}

export { schema };
