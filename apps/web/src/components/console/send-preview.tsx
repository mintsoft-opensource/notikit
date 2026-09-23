"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Bell, BellOff, ChevronDown, Link2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

type Platform = "ios" | "android";

const IOS_FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const ANDROID_FONT = 'Roboto, "Google Sans", system-ui, sans-serif';

type PreviewContent = { appName: string; title: string; body: string; imageUrl: string | null };

/**
 * 잠금화면·알림창 모양의 미리보기. 플랫폼마다 잘리는 줄 수가 달라 탭으로 나눠 보여 준다 —
 * iOS 제목 1줄·본문 4줄, Android 접힘 제목 1줄·본문 1줄 / 펼침 본문 7줄.
 * 기기 모형은 실제 OS 색을 흉내 내므로 콘솔 테마(다크 모드)를 따르지 않는다.
 */
export function SendPreview({
  appName,
  title,
  body,
  imageUrl,
  deepLink,
  data,
  note,
  variants,
  silent,
  actions,
}: PreviewContent & {
  deepLink: string;
  data?: Record<string, string>;
  note?: string;
  /** A/B 변형(치환 후). 둘 이상이면 변형마다 탭으로 미리 본다 — 0번이 기본 내용(A) */
  variants?: Array<{ title: string; body: string }>;
  /** 무음 푸시 — 알림이 그려지지 않으므로 기기 모형 대신 그 사실을 설명한다 */
  silent?: boolean;
  /** 알림 액션 버튼 — 기기에서 알림 아래 줄에 붙는다 */
  actions?: Array<{ id: string; title: string; deep_link?: string }>;
}) {
  const t = useTranslations("send");
  const [platform, setPlatform] = React.useState<Platform>("ios");
  const [variantTab, setVariantTab] = React.useState("0");
  const idPrefix = React.useId();
  const variantIdPrefix = React.useId();
  const hasVariants = Boolean(variants && variants.length > 1);
  const variantIdx = hasVariants ? Math.min(Number(variantTab), variants!.length - 1) : 0;
  const picked = hasVariants ? variants![variantIdx] : { title, body };
  const content = { appName, title: picked.title || t("titlePlaceholder"), body: picked.body || t("bodyPlaceholder"), imageUrl };
  const isEmpty = { title: !picked.title, body: !picked.body };

  return (
    <Card>
      <CardHeader className="items-center pb-0">
        <CardTitle>{t("preview")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        {silent ? (
          <div className="flex gap-2.5 rounded-lg border border-border bg-surface-muted/50 p-3">
            <BellOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold">{t("previewSilent")}</p>
              <p className="text-xs text-muted-foreground">{t("previewSilentHint")}</p>
            </div>
          </div>
        ) : (
          <>
        {hasVariants && (
          <Tabs
            value={String(variantIdx)}
            onChange={setVariantTab}
            label={t("previewVariant")}
            idPrefix={variantIdPrefix}
            items={variants!.map((_, i) => ({ value: String(i), label: t("variantName", { letter: String.fromCharCode(65 + i) }) }))}
          />
        )}
        <VariantPanel active={hasVariants} value={String(variantIdx)} idPrefix={variantIdPrefix}>
          <Tabs
            value={platform}
            onChange={setPlatform}
            label={t("previewPlatform")}
            idPrefix={idPrefix}
            items={[
              { value: "ios", label: "iOS" },
              { value: "android", label: "Android" },
            ]}
          />
          <TabPanel value={platform} idPrefix={idPrefix}>
            {platform === "ios" ? <IosMock {...content} isEmpty={isEmpty} /> : <AndroidMock {...content} isEmpty={isEmpty} />}
          </TabPanel>
        </VariantPanel>
          </>
        )}
        {actions && actions.length > 0 && (
          <ul aria-label={t("previewActions")} className="flex flex-wrap gap-2">
            {actions.map((a) => (
              <li
                key={a.id}
                className="inline-flex h-7 max-w-full items-center rounded-lg border border-border bg-surface-muted/60 px-2.5 text-xs font-semibold"
              >
                <span className="truncate">{a.title}</span>
              </li>
            ))}
          </ul>
        )}
        {note && !silent && <p className="text-xs text-muted-foreground">{note}</p>}
        {deepLink && (
          <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <Link2 aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className="truncate font-mono">{deepLink}</span>
          </p>
        )}
        {data && (
          <dl className="space-y-1 rounded-lg border border-border p-2.5 font-mono text-2xs">
            {Object.entries(data).map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2">
                <dt className="shrink-0 text-muted-foreground">{k}</dt>
                <dd className="truncate">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

type MockProps = PreviewContent & { isEmpty: { title: boolean; body: boolean } };

function IosMock({ appName, title, body, imageUrl, isEmpty }: MockProps) {
  const t = useTranslations("send");
  return (
    <div
      data-platform="ios"
      className="rounded-[1.25rem] bg-[linear-gradient(160deg,#3d5a80_0%,#6d6a9c_45%,#c9897b_100%)] p-3 pt-10"
      style={{ fontFamily: IOS_FONT }}
    >
      <div className="flex gap-2.5 rounded-[1.1rem] bg-white/80 p-2.5 text-[#111] shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-xl">
        <AppIcon className="h-9 w-9 rounded-[0.6rem]" label={appName} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className={cn("line-clamp-1 min-w-0 flex-1 text-[13px] font-semibold leading-[1.3]", isEmpty.title && "text-black/40")}>{title}</p>
            <span className="shrink-0 text-[11px] text-black/45">{t("previewNow")}</span>
          </div>
          <p className={cn("line-clamp-4 whitespace-pre-line break-words text-[13px] leading-[1.3]", isEmpty.body ? "text-black/40" : "text-black/80")}>{body}</p>
        </div>
        {imageUrl && <PreviewImage src={imageUrl} className="h-9 w-9 shrink-0 self-center rounded-md" />}
      </div>
    </div>
  );
}

function AndroidMock({ appName, title, body, imageUrl, isEmpty }: MockProps) {
  const t = useTranslations("send");
  const [expanded, setExpanded] = React.useState(false);
  return (
    <div
      data-platform="android"
      data-expanded={expanded || undefined}
      className="rounded-[1.25rem] bg-[#dde3ea] p-3"
      style={{ fontFamily: ANDROID_FONT }}
    >
      <div className="rounded-[1.5rem] bg-[#f8f9ff] p-3.5 text-[#191c20] shadow-[0_1px_2px_rgba(0,0,0,0.12)]">
        <div className="flex items-center gap-1.5 text-[11px] text-[#43474e]">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
            <Bell aria-hidden="true" className="h-3 w-3" />
          </span>
          <span className="truncate">{appName}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{t("previewNow")}</span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="ms-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-[#e1e2ec] px-2 text-[11px] font-medium text-[#191c20] transition-colors hover:bg-[#d3d5e0] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {expanded ? t("previewCollapse") : t("previewExpand")}
            <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform duration-200", expanded && "rotate-180")} />
          </button>
        </div>
        <div className="mt-2 flex gap-3">
          <div className="min-w-0 flex-1">
            <p className={cn("line-clamp-1 text-[14px] font-medium leading-5", isEmpty.title && "text-[#191c20]/40")}>{title}</p>
            <p
              className={cn(
                "whitespace-pre-line break-words text-[13px] leading-[1.35]",
                expanded ? "line-clamp-7" : "line-clamp-1",
                isEmpty.body ? "text-[#43474e]/50" : "text-[#43474e]"
              )}
            >
              {body}
            </p>
          </div>
          {imageUrl && !expanded && <PreviewImage src={imageUrl} className="h-10 w-10 shrink-0 rounded-lg" />}
        </div>
        {imageUrl && expanded && <PreviewImage src={imageUrl} className="mt-2.5 aspect-[2/1] w-full rounded-xl" />}
      </div>
    </div>
  );
}

function AppIcon({ className, label }: { className?: string; label: string }) {
  return (
    <span role="img" aria-label={label} className={cn("grid shrink-0 place-items-center bg-primary text-primary-foreground shadow-sm", className)}>
      <Bell aria-hidden="true" className="h-4 w-4" />
    </span>
  );
}

/** 주소가 깨졌으면 자리를 비운다 — 깨진 이미지 아이콘이 실제 알림 모습처럼 보이면 안 된다 */
function PreviewImage({ src, className }: { src: string; className?: string }) {
  const t = useTranslations("send");
  const [broken, setBroken] = React.useState<string | null>(null);
  if (broken === src) return null;
  return <img src={src} alt={t("imagePreviewAlt")} className={cn("bg-black/5 object-cover", className)} onError={() => setBroken(src)} />;
}

/** 변형 탭이 있을 때만 tabpanel 로 감싼다 — 탭 없이 tabpanel 만 있으면 스크린리더가 헷갈린다 */
function VariantPanel({
  active,
  value,
  idPrefix,
  children,
}: {
  active: boolean;
  value: string;
  idPrefix: string;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <TabPanel value={value} idPrefix={idPrefix} className="space-y-3">
      {children}
    </TabPanel>
  );
}
