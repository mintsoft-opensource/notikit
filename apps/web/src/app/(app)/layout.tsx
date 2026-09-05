import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";

export default function AppShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-surface-muted">
      <Sidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Header />
        <main className="min-h-0 flex-1 overflow-y-auto bg-background">
          <div className="flex min-h-[calc(100dvh-3.5rem)] flex-col md:min-h-[calc(100dvh-4rem)]">
            <div className="flex-1 p-4 md:p-8">{children}</div>
          </div>
        </main>
      </div>
    </div>
  );
}
