"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";
import type { DocMeta } from "@/lib/docs";
import { FOCUS_RING } from "@/components/ui/focus-ring";

/**
 * 문서 목차 — 파일 목록에서 그대로 만들어진다.
 *
 * 좁은 화면에서는 본문 위에 가로로 눕는다. 세로 목록을 그대로 두면 문서를 읽기까지
 * 목차 전체를 스크롤해야 한다.
 */
export function DocNav({ docs, label }: { docs: DocMeta[]; label: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="min-w-0 lg:sticky lg:top-4 lg:pt-3">
      {/* 구획 머리글은 Eyebrow 하나로 — 여기만 자간·굵기가 다르면 같은 층위가 다르게 읽힌다 */}
      <Eyebrow className="mb-1.5 hidden px-2.5 lg:block">{label}</Eyebrow>
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-0.5 lg:overflow-visible lg:pb-0">
        {docs.map((d, i) => {
          const active = pathname === `/guide/${d.slug}`;
          return (
            <li key={d.slug} className="shrink-0 lg:shrink">
              <Link
                href={`/guide/${d.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors lg:whitespace-normal",
                  FOCUS_RING,
                  active
                    ? "bg-accent-soft text-primary"
                    : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                )}
              >
                {/* 순번이 있으면 문서가 읽는 순서를 가진다는 것이 드러난다 */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "w-4 shrink-0 text-end font-mono text-2xs tabular-nums",
                    active ? "text-primary/70" : "text-muted-foreground/50"
                  )}
                >
                  {i + 1}
                </span>
                {d.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
