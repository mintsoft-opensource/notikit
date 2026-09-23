import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { EmptyState } from "./empty-state";

const GRID_LINES = [0.2, 0.4, 0.6, 0.8];
const GHOST_BARS = [0.35, 0.55, 0.42, 0.7, 0.5, 0.62, 0.3];
const GHOST_LINE = "M0,70 L16,58 L33,64 L50,40 L66,48 L83,30 L100,38";

/**
 * 차트 자리에 데이터가 없을 때 — 흐린 축·격자를 깔고 그 위에 빈 상태 문구를 둔다.
 * 빈 카드만 두면 "로딩 실패"인지 "아직 데이터 없음"인지 구분되지 않고, 차트가 들어올 자리라는 것도 안 보인다.
 * 배경은 장식이라 aria-hidden, 읽히는 것은 제목·설명뿐이다. 서버 컴포넌트에서도 쓸 수 있다.
 */
export function ChartEmpty({
  title,
  description,
  icon,
  kind = "line",
  className,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** 배경 모양 — 선 차트 자리면 line, 막대 차트 자리면 bar */
  kind?: "line" | "bar";
  /** 높이는 실제 차트와 같게 준다(예: h-56) — 데이터가 들어와도 레이아웃이 튀지 않게 */
  className?: string;
}) {
  return (
    <div className={cn("relative h-56 w-full overflow-hidden", className)}>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full text-border"
      >
        {GRID_LINES.map((y) => (
          <line key={y} x1="0" x2="100" y1={y * 100} y2={y * 100} stroke="currentColor" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
        ))}
        <line x1="0" x2="100" y1="99.5" y2="99.5" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {kind === "bar" ? (
          GHOST_BARS.map((h, i) => {
            const slot = 100 / GHOST_BARS.length;
            return <rect key={i} x={i * slot + slot * 0.25} width={slot * 0.5} y={100 - h * 100} height={h * 100} fill="currentColor" opacity="0.35" />;
          })
        ) : (
          <path d={GHOST_LINE} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" opacity="0.8" />
        )}
      </svg>
      <div className="relative flex h-full items-center justify-center">
        <EmptyState icon={icon} title={title} description={description} className="rounded-card bg-surface/85 py-4" />
      </div>
    </div>
  );
}
