import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * goji/webapp EmptyState — 아이콘 + 제목 + 설명 + 액션.
 *
 * `tone="error"` 는 **실패**다. 빈 목록과 오류가 똑같이 회색으로 나오면 "아직 없음"과
 * "가져오지 못함"을 구분할 수 없어, 운영자가 다시 시도해야 할 자리에서 그냥 기다린다.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "default",
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  tone?: "default" | "error";
  className?: string;
}) {
  const isError = tone === "error";
  return (
    <div className={cn("flex flex-col items-center justify-center px-4 py-8 text-center", className)}>
      {Icon && (
        // 아이콘 컨테이너 규칙(28px 보조 / 36px 조작) 중 큰 쪽 — 빈 화면의 시선 기준점이라
        <div
          className={cn(
            "mb-3 flex h-9 w-9 items-center justify-center rounded-lg",
            isError ? "bg-error/10" : "bg-surface-muted"
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-4", isError ? "text-error" : "text-muted-foreground")}
            strokeWidth={1.75}
          />
        </div>
      )}
      <h3 className="text-base font-bold text-foreground">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
