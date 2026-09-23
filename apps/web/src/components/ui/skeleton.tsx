import { cn } from "@/lib/utils";

/** goji/webapp Skeleton — 로딩 자리표시. "…" 를 큰 볼드 숫자로 렌더하지 않기 위해 씀 */
export function Skeleton({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("motion-safe:animate-pulse rounded-md bg-surface-muted/80", className)} {...rest} />;
}
