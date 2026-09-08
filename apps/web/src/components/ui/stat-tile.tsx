import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "./card";
import { Skeleton } from "./skeleton";
import { cn } from "@/lib/utils";

export type StatTileAccent = "default" | "primary" | "success" | "warning" | "muted";

const accentClass: Record<StatTileAccent, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/** goji/webapp StatTile — 라벨 + 아이콘 배지 + 큰 수치 + 힌트 */
export function StatTile({
  label,
  value,
  icon: Icon,
  hint,
  accent = "default",
  suffix,
  loading,
}: {
  label: string;
  value: string | number;
  icon?: LucideIcon;
  hint?: string | null;
  accent?: StatTileAccent;
  suffix?: string;
  /** 로딩 중 — 값 자리에 "…" 를 큰 볼드로 찍지 않고 스켈레톤을 보여준다 */
  loading?: boolean;
}) {
  return (
    <Card className="min-w-0">
      <CardContent className="p-5">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs font-semibold text-muted-foreground" title={label}>
            {label}
          </p>
          {Icon && (
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft">
              <Icon aria-hidden="true" className="h-3.5 w-3.5 text-primary" strokeWidth={2.25} />
            </div>
          )}
        </div>
        {loading ? (
          <Skeleton className="mt-2 h-7 w-20" />
        ) : (
          <p className={cn("mt-2 truncate text-xl font-extrabold tracking-tight tabular-nums", accentClass[accent])}>
            {value}
            {suffix && <span className="ml-1 text-xs font-bold text-muted-foreground">{suffix}</span>}
          </p>
        )}
        {hint && <p className="mt-1 truncate text-2xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}
