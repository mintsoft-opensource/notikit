import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/session";
import { isSessionValid } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** 루트 — 랜딩 없이 세션 유무로 콘솔/로그인 분기. 최초 설치(관리자 0명)는 /login 이 register 모드로 안내. */
export default async function Home() {
  const store = await cookies();
  if (await isSessionValid(store.get(SESSION_COOKIE)?.value)) redirect("/dashboard");
  redirect("/login");
}
