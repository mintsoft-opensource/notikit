"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Copy, ChevronRight, FolderKanban, AlertTriangle, RotateCw, Rocket, Flame, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatTile } from "@/components/ui/stat-tile";
import { Card } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";
import { FOCUS_RING_INSET } from "@/components/ui/focus-ring";
import { useNumberFormat } from "@/lib/number-format";

export default function ProjectsPage() {
  const t = useTranslations("projects");
  const errorText = useAdminErrorText();
  const ts = useTranslations("settings");
  const tc = useTranslations("common");
  const locale = useLocale();
  // 요약 수치도 콘솔의 다른 수치와 같은 로케일 서식으로 — 여기만 1234 처럼 맨숫자로 보이지 않게
  const nf = useNumberFormat();
  const { projects, loading, error, reload } = useProjects();
  // 목록을 한 번도 못 받은 실패만 오류 화면으로 — 이미 보이는 목록을 재로드 실패로 지우지 않는다
  const loadFailed = !loading && !!error && projects.length === 0;
  const [name, setName] = React.useState("");
  const [environment, setEnvironment] = React.useState("dev");
  const [secret, setSecret] = React.useState<{ key: string; secret: string } | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  /**
   * 모달을 닫는다. **발급된 시크릿이 떠 있으면 닫지 않는다** — api_secret 은 이 화면을
   * 벗어나면 다시 볼 수 없고, 배경 클릭이나 Esc 한 번에 날아가면 복구할 방법이 없다.
   */
  function requestClose() {
    if (secret) return;
    setOpen(false);
    setName("");
  }

  function dismissSecret() {
    setSecret(null);
    setOpen(false);
    setName("");
  }

  async function copy(value: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(okMessage);
    } catch {
      toast.error(t("copyFailedManual"));
    }
  }

  /** 요약 타일 — 목록에 이미 들어 있는 값만 센다(추가 호출 없음) */
  const summary = React.useMemo(
    () => ({
      total: projects.length,
      production: projects.filter((p) => p.environment === "production").length,
      firebase: projects.filter((p) => p.hasFirebase).length,
      logOnly: projects.filter((p) => !p.hasFirebase).length,
    }),
    [projects]
  );

  async function create() {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const d = await adminApi<{ project: { apiKey: string }; api_secret: string }>("/api/admin/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), environment }),
      });
      setSecret({ key: d.project.apiKey, secret: d.api_secret });
      toast.success(t("created"));
      reload();
    } catch (e) {
      toast.error(errorText(e, t("createFailed")));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" className="size-4" /> {t("newProject")}
          </Button>
        }
      />

      <Dialog
        open={open}
        onClose={requestClose}
        title={secret ? t("secretNotice") : t("newProject")}
        description={secret ? undefined : t("subtitle")}
        footer={
          secret ? (
            <Button onClick={dismissSecret}>{t("close")}</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={requestClose}>{t("close")}</Button>
              <Button onClick={create} disabled={creating || !name.trim()}>
                <Plus aria-hidden="true" className="size-4" /> {t("create")}
              </Button>
            </>
          )
        }
      >
        {secret ? (
          /* 한 번만 보이는 값이다. 닫기 전까지 폼으로 돌아가지 않는다. */
          <div className="space-y-1">
            {/* 칸 밖에 따로 서 있는 버튼 — 공통 Button 으로 36px·포커스 링을 맞춘다 */}
            <Button variant="outline" className="w-full justify-between font-mono text-xs font-normal" onClick={() => copy(secret.key, t("apiKeyCopied"))}>
              <span className="min-w-0 truncate">api_key: {secret.key}</span> <Copy aria-hidden="true" />
            </Button>
            <Button variant="outline" className="w-full justify-between font-mono text-xs font-normal" onClick={() => copy(secret.secret, t("apiSecretCopied"))}>
              <span className="min-w-0 truncate">api_secret: {secret.secret}</span> <Copy aria-hidden="true" />
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => { e.preventDefault(); void create(); }}
          >
            <div className="space-y-1">
              <Label htmlFor="new-project-name">{t("nameLabel")}</Label>
              <Input id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="new-project-env">{t("envLabel")}</Label>
              <Select id="new-project-env" value={environment} onChange={(e) => setEnvironment(e.target.value)} className="w-full">
                <option value="dev">dev</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
              </Select>
            </div>
            {/* Enter 로 제출되게 하되 버튼은 푸터에 있으므로 화면에는 보이지 않는다 */}
            <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
          </form>
        )}
      </Dialog>

      {/* 목록이 하나라도 있을 때만 — 빈 화면에 0 만 네 개 띄우지 않는다 */}
      {projects.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label={t("summaryTotal")} value={nf.format(summary.total)} icon={FolderKanban} />
          <StatTile label={t("summaryProduction")} value={nf.format(summary.production)} icon={Rocket} accent="primary" />
          <StatTile label={t("summaryFirebase")} value={nf.format(summary.firebase)} icon={Flame} hint={t("summaryFirebaseHint")} />
          <StatTile label={tc("logOnly")} value={nf.format(summary.logOnly)} icon={FileText} accent="muted" hint={t("summaryLogOnlyHint")} />
        </div>
      )}

      <Card className="overflow-hidden">
        {loading && projects.length === 0 && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
        {loadFailed && (
          <EmptyState
            icon={AlertTriangle}
            title={tc("loadFailed")}
            action={<Button size="sm" variant="outline" onClick={() => void reload()}><RotateCw aria-hidden="true" />{tc("retry")}</Button>}
          />
        )}
        {!loading && !error && projects.length === 0 && <EmptyState icon={FolderKanban} title={t("empty")} description={t("subtitle")} action={<Button size="sm" variant="outline" onClick={() => setOpen(true)}><Plus aria-hidden="true" className="size-4" />{t("newProject")}</Button>} />}
        {projects.length > 0 && <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_1rem] gap-3 border-b border-border bg-surface-muted/50 px-3.5 py-2 text-xs font-semibold text-muted-foreground lg:grid"><span>{t("nameLabel")}</span><span>{ts("apiKeyLabel")}</span><span>{t("envLabel")}</span><span /></div>}
        {projects.map((p) => (
          <Link
            key={p.id}
            href={`/projects/${p.id}`}
            // 행 전체가 링크다. 표 role 을 씌우면 링크 의미가 깨지므로, 대신 링크에
            // 이름을 준다 — 스크린리더는 이름 없이 "링크"로만 읽고 지나간다.
            aria-label={`${p.name} · ${p.environment} · ${p.hasFirebase ? "Firebase" : tc("logOnly")}`}
            className={cn(
              "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border px-3.5 py-2.5 transition-colors last:border-b-0 hover:bg-surface-muted/50 lg:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1.5fr)_1rem]",
              FOCUS_RING_INSET
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-primary"><FolderKanban aria-hidden="true" className="size-4" /></span>
              <span className="truncate text-sm font-semibold">{p.name}</span>
            </div>
            <p className="col-start-1 row-start-2 truncate font-mono text-xs text-muted-foreground lg:col-start-auto lg:row-start-auto">{p.apiKey}</p>
            <div className="col-start-1 flex flex-wrap items-center gap-2 lg:col-start-auto">
              <Badge variant={p.environment === "production" ? "primary" : "neutral"}>{p.environment}</Badge>
              {p.hasFirebase ? <Badge variant="success">Firebase</Badge> : <Badge variant="neutral">{tc("logOnly")}</Badge>}
            </div>
            <ChevronRight aria-hidden="true" className="col-start-2 row-start-1 size-4 shrink-0 text-muted-foreground lg:col-start-4" />
          </Link>
        ))}
      </Card>
    </div>
  );
}
