import { Skeleton } from "@/components/ui/skeleton";

/** 목차는 레이아웃에 남아 있다 — 본문만 자리표시하면 문서를 옮길 때 목차가 깜빡이지 않는다 */
export default function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-3.5 w-full" />
      <Skeleton className="h-3.5 w-11/12" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-3.5 w-10/12" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
