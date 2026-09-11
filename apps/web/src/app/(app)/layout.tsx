import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { AppFooter } from "@/components/layout/app-footer";
import { SESSION_COOKIE } from "@/lib/session";
import { isSessionValid } from "@/lib/authz";

export default async function AppShellLayout({ children }: { children: React.ReactNode }) {
  const store = await cookies();
  if (!(await isSessionValid(store.get(SESSION_COOKIE)?.value))) redirect("/login");

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-surface-muted">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header />
        {/* 스크롤은 여기서만 일어난다. 푸터를 main 밖으로 빼서 항상 보이게 하고,
            헤더 높이에 맞춘 min-h calc 도 걷어냈다 — 짧은 콘텐츠에서 푸터를 아래로
            밀어내던 장치라 이제 필요 없다. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-surface-alt">
          {/* min-w-0 없으면 flex 아이템이 콘텐츠 폭 아래로 줄지 못한다. 넓은 차트·테이블이
              래퍼를 밀어내 가로 오버플로가 생기고, 바깥이 overflow-hidden 이라 잘려 나간다. */}
          <div className="min-w-0 p-3 md:p-4">{children}</div>
        </main>
        <AppFooter />
      </div>
    </div>
  );
}
