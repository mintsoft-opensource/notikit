import { Skeleton } from "@/components/ui/skeleton";

/**
 * 페이지 전환 중 보여 줄 자리표시.
 *
 * 스피너 대신 자리표시를 쓰는 이유는 **레이아웃이 튀지 않게** 하기 위해서다. 도착할
 * 화면과 같은 자리에 같은 크기의 블록을 두면, 내용이 채워질 때 무엇도 움직이지 않는다.
 * 그래서 변형(variant)은 장식이 아니라 실제 화면 구조와 짝지어야 한다.
 */
type Variant = "table" | "stats" | "form" | "detail" | "docs" | "frame";

export function PageSkeleton({ variant = "table" }: { variant?: Variant }) {
  return (
    <div className="w-full space-y-4">
      <Header />
      {variant === "table" && <TableBlock />}
      {variant === "stats" && (
        <>
          <StatRow />
          <TableBlock rows={6} />
        </>
      )}
      {variant === "form" && <FormBlock />}
      {variant === "detail" && (
        <>
          <StatRow />
          <div className="grid gap-4 lg:grid-cols-2">
            <CardBlock />
            <CardBlock />
          </div>
        </>
      )}
      {variant === "docs" && <DocsBlock />}
      {variant === "frame" && <Skeleton className="h-[calc(100vh-11rem)] w-full" />}
    </div>
  );
}

function Header() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-6 w-44" />
      <Skeleton className="h-3.5 w-72" />
    </div>
  );
}

function StatRow() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="space-y-2 border border-border bg-surface p-4 shadow-card">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-24" />
        </div>
      ))}
    </div>
  );
}

function TableBlock({ rows = 8 }: { rows?: number }) {
  return (
    <div className="border border-border bg-surface shadow-card">
      {/* 헤더 줄 — 실제 표에도 항상 헤더가 있으므로 자리표시에도 있어야 한다 */}
      <div className="flex items-center gap-4 border-b border-border bg-surface-muted px-4 py-2.5">
        {/* 헤더 줄은 배경이 이미 surface-muted 라, 같은 색 자리표시는 묻혀 사라진다 */}
        {[16, 24, 20, 14].map((w, i) => (
          <Skeleton key={i} className="h-3 bg-border" style={{ width: `${w}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
          {[16, 24, 20, 14].map((w, j) => (
            <Skeleton key={j} className="h-3.5" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function CardBlock() {
  return (
    <div className="space-y-3 border border-border bg-surface p-4 shadow-card">
      <Skeleton className="h-4 w-32" />
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex justify-between gap-4">
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-3.5 w-20" />
        </div>
      ))}
    </div>
  );
}

function FormBlock() {
  return (
    <div className="space-y-4 border border-border bg-surface p-4 shadow-card">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-9 w-full max-w-md" />
        </div>
      ))}
      <Skeleton className="h-9 w-28" />
    </div>
  );
}

function DocsBlock() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="space-y-1.5">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-full" />
        ))}
      </div>
      <div className="space-y-3 border border-border bg-surface px-4 py-3 shadow-card">
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-3.5 w-10/12" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
