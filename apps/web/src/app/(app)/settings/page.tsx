"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Save, Users, FolderKanban, CalendarDays, AlertTriangle, RotateCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { StatTile } from "@/components/console/panels";
import { EmptyState } from "@/components/ui/empty-state";
import { useSession, adminApi, useAdminErrorText } from "@/lib/admin-client";

type Org = { id: string; name: string; createdAt: string; members: number; projects: number };

/** 조직 설정 — 내 계정·멤버는 계정 화면, 발송 정책은 프로젝트 상세에서 관리 */
export default function SettingsPage() {
  const t = useTranslations("orgSettings");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();
  const { user } = useSession();
  const isOwner = user?.role === "owner";

  const [org, setOrg] = React.useState<Org | null>(null);
  const [error, setError] = React.useState(false);
  const [name, setName] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ org: Org | null }>("/api/admin/org");
      setOrg(d.org);
      setName(d.org?.name ?? "");
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function retry() {
    setError(false); // 재시도 중엔 다시 로딩 표시
    void load();
  }

  // 첫 로드 실패는 빈 기본값("—"·"불러오는 중…")으로 위장하지 않고 오류 + 재시도로 보인다
  const loadFailed = error && !org;

  async function save() {
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await adminApi("/api/admin/org", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      toast.success(t("orgSaved"));
      await load();
    } catch (e) {
      toast.error(errorText(e, t("orgSaveFailed")));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile icon={Users} label={t("statMembers")} value={org ? String(org.members) : "—"} loading={!org && !error} />
        <StatTile icon={FolderKanban} label={t("statProjects")} value={org ? String(org.projects) : "—"} loading={!org && !error} />
        <StatTile icon={CalendarDays} label={t("statSince")} value={org ? df.format(new Date(org.createdAt)) : "—"} loading={!org && !error} />
      </div>

      {loadFailed ? (
        <Card>
          <EmptyState
            icon={AlertTriangle}
            title={tc("loadFailed")}
            action={<Button size="sm" variant="outline" onClick={retry}><RotateCw aria-hidden="true" />{tc("retry")}</Button>}
          />
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{t("orgTitle")}</CardTitle>
              <CardDescription>{isOwner ? t("orgDesc") : t("orgReadOnly")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Field label={t("orgName")}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!isOwner || !org}
                maxLength={120}
                placeholder={tc("loading")}
              />
            </Field>
            {isOwner && (
              <Button className="justify-self-end" onClick={save} disabled={saving || !org || !name.trim() || name.trim() === org?.name}>
                <Save aria-hidden="true" className="h-4 w-4" /> {saving ? t("saving") : t("save")}
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
