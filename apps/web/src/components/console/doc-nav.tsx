"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { DocMeta } from "@/lib/docs";

/** 문서 목차 — 파일 목록에서 그대로 만들어진다. */
export function DocNav({ docs, label }: { docs: DocMeta[]; label: string }) {
  const pathname = usePathname();

  return (
    <nav aria-label={label} className="lg:sticky lg:top-4">
      <p className="mb-1.5 px-2.5 text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </p>
      <ul className="space-y-0.5">
        {docs.map((d) => {
          const active = pathname === `/guide/${d.slug}`;
          return (
            <li key={d.slug}>
              <Link
                href={`/guide/${d.slug}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block rounded-lg px-2.5 py-1.5 text-sm font-semibold transition-colors",
                  active
                    ? "bg-surface-muted text-foreground"
                    : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
                )}
              >
                {d.title}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
