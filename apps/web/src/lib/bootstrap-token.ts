import { createHmac } from "node:crypto";

/**
 * 첫 관리자 등록(부트스트랩)에 요구하는 토큰. null 이면 요구하지 않는다(개발 서버).
 *
 * 저장소가 공개라 새로 띄운 인스턴스를 찾아 먼저 등록하는 선점이 현실적이다 — 첫 관리자는
 * 인스턴스 운영자 권한까지 얻는다. 그래서 운영에서는 설정이 없어도 토큰을 요구한다.
 * 값은 암호화 키에서 파생한다: 재시작·여러 대에서 같은 값이고, 운영자는 부팅 로그에서 읽는다
 * (`docker compose logs web`). 키 자체는 드러나지 않는다(HMAC).
 */
export function bootstrapToken(env: Record<string, string | undefined> = process.env): string | null {
  if (env.BOOTSTRAP_TOKEN) return env.BOOTSTRAP_TOKEN;
  if (env.NODE_ENV !== "production" || !env.NOTIKIT_ENCRYPTION_KEY) return null;
  return createHmac("sha256", env.NOTIKIT_ENCRYPTION_KEY).update("notikit:bootstrap").digest("hex").slice(0, 32);
}

/**
 * 부팅 때 한 번 — 관리자가 아직 없고 운영자가 토큰을 정하지 않았으면 파생 토큰을 로그에 남긴다.
 * 운영자가 콘솔 첫 화면에서 그 값을 넣어 첫 관리자를 만든다. 관리자가 생긴 뒤에는 찍지 않는다.
 * 조회가 실패해도 부팅은 막지 않는다(DB 준비 여부는 readiness 가 따로 본다).
 */
export async function announceBootstrapToken(): Promise<void> {
  if (process.env.BOOTSTRAP_TOKEN) return;
  const token = bootstrapToken();
  if (!token) return;
  try {
    const { getDb } = await import("@/db/client");
    const { adminUsers } = await import("@/db/schema");
    const rows = await getDb().select({ id: adminUsers.id }).from(adminUsers).limit(1);
    if (rows.length > 0) return;
    console.log(`[notikit] 첫 관리자 등록 토큰: ${token}\n[notikit] 콘솔 첫 화면의 "부트스트랩 토큰" 칸에 넣으세요. 관리자가 생기면 더는 쓰이지 않습니다.`);
  } catch {
    // DB 가 아직이면 다음 부팅에 다시 찍힌다
  }
}
