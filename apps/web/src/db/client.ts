import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const globalForDb = globalThis as unknown as {
  __notikitSql?: ReturnType<typeof postgres>;
};

function getSql() {
  if (!globalForDb.__notikitSql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // postgres-js 는 lazy — 첫 쿼리 전까지 연결 안 함
    globalForDb.__notikitSql = postgres(url, { max: 10 });
  }
  return globalForDb.__notikitSql;
}

export function getDb() {
  return drizzle(getSql(), { schema });
}

export { schema };
