"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { StatStrip } from "@/components/console/panels";
import { useSession, adminApi } from "@/lib/admin-client";

type Org = { id: string; name: string; createdAt: string; members: number; projects: number };

/** 조직 설정 — 내 계정·멤버는 계정 화면, 발송 정책은 프로젝트 상세에서 관리 */
export default function SettingsPage() {
  const t = useTranslations("orgSettings");
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

  async function save() {
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      await adminApi("/api/admin/org", { method: "PATCH", body: JSON.stringify({ name: name.trim() }) });
      toast.success(t("orgSaved"));
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("orgSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full space-y-5">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <StatStrip
        cols="grid-cols-3"
        cells={[
          { key: "members", label: t("statMembers"), value: org ? String(org.members) : error ? "—" : "…" },
          { key: "projects", label: t("statProjects"), value: org ? String(org.projects) : error ? "—" : "…" },
          { key: "since", label: t("statSince"), value: org ? df.format(new Date(org.createdAt)) : error ? "—" : "…" },
        ]}
      />

      <Card>
        <CardHeader>
          <CardTitle>{t("orgTitle")}</CardTitle>
          <CardDescription>{isOwner ? t("orgDesc") : t("orgReadOnly")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
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
            <Button size="sm" onClick={save} disabled={saving || !org || !name.trim() || name.trim() === org?.name}>
              <Save aria-hidden="true" className="h-4 w-4" /> {saving ? t("saving") : t("save")}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
