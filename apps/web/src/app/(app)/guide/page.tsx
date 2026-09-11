"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Info, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/layout/page-header";
import { guideSections, type GuideBlock } from "@/content/guide";

function Block({ block }: { block: GuideBlock }) {
  if (block.kind === "p") {
    return <p className="text-sm leading-relaxed text-muted-foreground">{block.text}</p>;
  }

  if (block.kind === "list") {
    return (
      <ul className="space-y-1.5 text-sm leading-relaxed text-muted-foreground">
        {block.items.map((it) => (
          <li key={it} className="flex gap-2">
            <span aria-hidden="true" className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (block.kind === "note") {
    const warn = block.tone === "warn";
    const Icon = warn ? TriangleAlert : Info;
    return (
      <div
        className={
          warn
            ? "flex gap-2 border-l-2 border-warning bg-warning/5 px-3 py-2"
            : "flex gap-2 border-l-2 border-primary bg-accent-soft/40 px-3 py-2"
        }
      >
        <Icon aria-hidden="true" className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${warn ? "text-warning" : "text-primary"}`} />
        <p className="text-sm leading-relaxed text-foreground/80">{block.text}</p>
      </div>
    );
  }

  if (block.kind === "code") {
    return (
      <figure className="min-w-0">
        <figcaption className="mb-1 font-mono text-2xs text-muted-foreground">{block.lang}</figcaption>
        {/* 넓은 코드가 페이지를 가로로 밀지 않도록 자기 안에서 스크롤시킨다 */}
        <pre className="min-w-0 overflow-x-auto border border-border bg-surface-muted/50 p-3">
          <code className="font-mono text-xs leading-relaxed text-foreground">{block.code}</code>
        </pre>
      </figure>
    );
  }

  return (
    <div className="min-w-0 overflow-x-auto border border-border">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="border-b border-border bg-surface-muted/50">
          <tr>
            {block.head.map((h) => (
              <th key={h} scope="col" className="whitespace-nowrap px-3 py-2 text-xs font-semibold text-muted-foreground">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {block.rows.map((row) => (
            <tr key={row.join("|")}>
              {row.map((cell, i) => (
                <td
                  key={i}
                  className={
                    i === 0
                      ? "px-3 py-2 align-top font-semibold text-foreground"
                      : "px-3 py-2 align-top leading-relaxed text-muted-foreground"
                  }
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 사용 가이드 — API 레퍼런스(/docs)가 "무엇이 있는가"라면 여기는 "어떻게 쓰는가". */
export default function GuidePage() {
  const t = useTranslations("guide");
  const locale = useLocale();
  const sections = React.useMemo(() => guideSections(locale), [locale]);

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="min-w-0 space-y-3">
          {sections.map((sec) => (
            <Card key={sec.id} id={sec.id} className="min-w-0 scroll-mt-4">
              <CardHeader>
                <CardTitle>{sec.title}</CardTitle>
              </CardHeader>
              <CardContent className="min-w-0 space-y-3">
                {sec.blocks.map((b, i) => (
                  <Block key={i} block={b} />
                ))}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* 목차 — 화면이 좁으면 본문 위로 내려가는 대신 숨긴다(짧은 목록이라 스크롤이 더 빠르다) */}
        <nav aria-label={t("toc")} className="hidden xl:sticky xl:top-4 xl:block">
          <p className="mb-1.5 px-2.5 text-2xs font-bold uppercase tracking-[0.06em] text-muted-foreground">
            {t("toc")}
          </p>
          <ul className="space-y-0.5">
            {sections.map((sec) => (
              <li key={sec.id}>
                <a
                  href={`#${sec.id}`}
                  className="block rounded-lg px-2.5 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground"
                >
                  {sec.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
  );
}
