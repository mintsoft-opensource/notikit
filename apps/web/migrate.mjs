/**
 * DB 마이그레이션 실행 — drizzle 저널 기반(멱등). 컨테이너 기동 시 자동 적용.
 * env: DATABASE_URL, DRIZZLE_DIR(기본 ./apps/web/drizzle)
 */
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[migrate] DATABASE_URL is required");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = process.env.DRIZZLE_DIR ?? path.join(here, "drizzle");
const sql = postgres(url, { max: 1 });

try {
  await migrate(drizzle(sql), { migrationsFolder: dir });
  console.log("[migrate] up to date");
} catch (err) {
  console.error("[migrate] failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
