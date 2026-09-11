import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** goji/webapp EmptyState — 아이콘 + 제목 + 설명 + 액션 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-4 py-8 text-center", className)}>
      {Icon && (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-muted">
          <Icon aria-hidden="true" className="h-5 w-5 text-muted-foreground/70" strokeWidth={1.75} />
        </div>
      )}
      <h3 className="text-base font-bold text-foreground">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
