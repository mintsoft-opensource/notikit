"use client";

import { useTranslations } from "next-intl";
import { Bell, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** 잠금화면 알림 모양의 미리보기 — 제목·본문이 실제로 어떻게 잘리는지 보고 보내게 한다 */
export function SendPreview({
  appName,
  title,
  body,
  deepLink,
  note,
}: {
  appName: string;
  title: string;
  body: string;
  deepLink: string;
  note?: string;
}) {
  const t = useTranslations("send");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("preview")}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="rounded-[1.25rem] bg-gradient-to-b from-surface-muted to-surface-alt p-3">
          <div className="rounded-2xl border border-border bg-surface/95 p-3 shadow-sm">
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span className="grid h-5 w-5 place-items-center rounded-md bg-primary text-primary-foreground">
                <Bell aria-hidden="true" className="h-3 w-3" />
              </span>
              <span className="truncate font-semibold uppercase tracking-wide">{appName}</span>
              <span className="ml-auto shrink-0">{t("previewNow")}</span>
            </div>
            <p className={`mt-2 line-clamp-1 text-sm font-semibold ${title ? "" : "text-muted-foreground"}`}>
              {title || t("titlePlaceholder")}
            </p>
            <p className={`mt-0.5 line-clamp-3 whitespace-pre-line text-sm leading-snug ${body ? "text-foreground/80" : "text-muted-foreground"}`}>
              {body || t("bodyPlaceholder")}
            </p>
          </div>
        </div>
        {note && <p className="mt-3 text-xs text-muted-foreground">{note}</p>}
        {deepLink && (
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Link2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate font-mono">{deepLink}</span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
