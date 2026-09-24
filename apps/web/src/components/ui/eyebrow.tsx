import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 구획 머리글(eyebrow) — 카드/다이얼로그 **안**에서 작은 묶음을 가르는 라벨.
 *
 * 값이 파일마다 조금씩 달라지면(11px bold / 12px semibold / tracking 0.06 vs 0.08)
 * 같은 층위인데 다른 것처럼 읽힌다. 크기·굵기·자간은 여기서만 정하고 전부 이걸 쓴다.
 * 문서 목차에 들어가야 하는 제목이면 `as="h4"` 처럼 heading 으로 렌더한다 —
 * 기본은 카드 제목(CardTitle)에 딸린 라벨이라 heading 이 아니다.
 */
export function Eyebrow({
  as: Tag = "p",
  className,
  ...props
}: React.HTMLAttributes<HTMLElement> & { as?: "p" | "h3" | "h4" | "h5" }) {
  return (
    <Tag
      className={cn("text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground", className)}
      {...props}
    />
  );
}
