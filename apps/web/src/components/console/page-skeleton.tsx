import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { STAT_TILE_GRID, statTileSpan } from "@/components/ui/stat-tile-grid";
import { cn } from "@/lib/utils";

/**
 * 페이지 전환 중 보여 줄 자리표시.
 *
 * 스피너 대신 자리표시를 쓰는 이유는 **레이아웃이 튀지 않게** 하기 위해서다. 도착할
 * 화면과 같은 자리에 같은 크기의 블록을 두면, 내용이 채워질 때 무엇도 움직이지 않는다.
 * 그래서 변형(variant)은 장식이 아니라 실제 화면 구조와 짝지어야 한다.
 *
 * 격자·여백은 **실제 컴포넌트에서 가져온다** — 여기에 숫자를 따로 적어 두면 한쪽만
 * 바뀌어 로딩이 끝나는 순간 화면이 눈에 띄게 튄다(StatTileGrid·DataTable·Card).
 */
type Variant = "table" | "stats" | "form" | "detail" | "docs" | "frame";

/** DataTable 의 행·헤더 좌우 여백과 같은 값 */
const ROW_X = "px-3.5";

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

/**
 * KPI 타일 줄 — StatTileGrid 와 같은 격자·같은 칸 span·같은 타일 속살(p-3, 아이콘 배지 28px,
 * 값 h-7)이다. 개수 기본값 5 는 프로젝트 개요의 타일 수다.
 */
function StatRow({ count = 5 }: { count?: number }) {
  return (
    <div className={STAT_TILE_GRID}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn("min-w-0 [&>*]:h-full", statTileSpan(i, count))}>
          <Card className="min-w-0">
            <CardContent className="p-3">
              <div className="flex items-center justify-between gap-2">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-7 w-7 rounded-lg" />
              </div>
              <Skeleton className="mt-2 h-7 w-24" />
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}

function TableBlock({ rows = 8 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden">
      {/* 헤더 줄 — 실제 표에도 항상 헤더가 있으므로 자리표시에도 있어야 한다 */}
      <div className={cn("flex items-center gap-4 border-b border-border bg-surface-muted/50 py-2", ROW_X)}>
        {/* 헤더 줄은 배경이 이미 surface-muted 라, 같은 색 자리표시는 묻혀 사라진다 */}
        {[16, 24, 20, 14].map((w, i) => (
          <Skeleton key={i} className="h-3 bg-border" style={{ width: `${w}%` }} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cn("flex min-h-12 items-center gap-4 border-b border-border py-2.5 last:border-b-0", ROW_X)}>
          {[16, 24, 20, 14].map((w, j) => (
            <Skeleton key={j} className="h-3.5" style={{ width: `${w}%` }} />
          ))}
        </div>
      ))}
    </Card>
  );
}

/** CardHeader(p-3.5 pb-2.5) + CardContent(p-3.5 pt-0) 와 같은 자리 */
function CardBlock() {
  return (
    <Card>
      <div className="p-3.5 pb-2.5">
        <Skeleton className="h-5 w-32" />
      </div>
      <CardContent className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex justify-between gap-4">
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="h-3.5 w-20" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** 폼 카드 — 칸은 실제 폼처럼 줄 전체를 쓴다(폭을 좁혀 두면 채워질 때 가로로 늘어난다) */
function FormBlock() {
  return (
    <Card>
      <CardContent className="space-y-4 p-3.5">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="space-y-1">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-9 w-full" />
          </div>
        ))}
        <Skeleton className="h-9 w-28" />
      </CardContent>
    </Card>
  );
}

function DocsBlock() {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <div className="space-y-1.5">
        {Array.from({ length: 9 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
      <Card className="min-w-0 px-4 py-3">
        <div className="space-y-3">
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-3.5 w-10/12" />
          <Skeleton className="h-40 w-full" />
        </div>
      </Card>
    </div>
  );
}
