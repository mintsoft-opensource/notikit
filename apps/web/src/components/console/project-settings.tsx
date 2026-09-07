"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Save, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi } from "@/lib/admin-client";

/** 프로젝트 설정 — 발송 정책(identity/방해금지) + Firebase/카카오 자격증명. 프로젝트 상세 전용. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const t = useTranslations("settings");
  const { projects, reload } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const [quietStart, setQuietStart] = React.useState("");
  const [quietEnd, setQuietEnd] = React.useState("");
  const [requireId, setRequireId] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const hydratedFor = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!project || hydratedFor.current === project.id) return;
    setRequireId(project.requireIdentityVerification ?? true);
    setQuietStart(project.quietStartHour == null ? "" : String(project.quietStartHour));
    setQuietEnd(project.quietEndHour == null ? "" : String(project.quietEndHour));
    hydratedFor.current = project.id;
  }, [project]);

  const [firebase, setFirebase] = React.useState("");
  const [firebaseBusy, setFirebaseBusy] = React.useState(false);
  const [kakao, setKakao] = React.useState({ provider_url: "", api_key: "", sender_key: "" });
  const [kakaoBusy, setKakaoBusy] = React.useState(false);

  async function savePolicy() {
    if (saving) return;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          require_identity_verification: requireId,
          quiet_start_hour: quietStart === "" ? null : Number(quietStart),
          quiet_end_hour: quietEnd === "" ? null : Number(quietEnd),
        }),
      });
      toast.success(t("policySaved"));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function uploadFirebase() {
    if (firebaseBusy) return;
    let creds: unknown;
    try {
      creds = JSON.parse(firebase);
    } catch {
      toast.error(t("jsonParseFailed"));
      return;
    }
    setFirebaseBusy(true);
    try {
      const d = await adminApi<{ firebase_project_id?: string }>(`/api/admin/projects/${projectId}/firebase`, {
        method: "POST",
        body: JSON.stringify({ credentials: creds }),
      });
      toast.success(`${t("firebaseSaved")}${d.firebase_project_id ? ` (${d.firebase_project_id})` : ""}`);
      setFirebase("");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("failed"));
    } finally {
      setFirebaseBusy(false);
    }
  }

  async function uploadKakao() {
    if (kakaoBusy) return;
    setKakaoBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/kakao`, { method: "POST", body: JSON.stringify(kakao) });
      toast.success(t("kakaoSaved"));
      setKakao({ provider_url: "", api_key: "", sender_key: "" });
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("failed"));
    } finally {
      setKakaoBusy(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <CardTitle>{t("policyTitle")}</CardTitle>
          <CardDescription>{t("policyDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requireId} onChange={(e) => setRequireId(e.target.checked)} className="h-4 w-4" />
            {t("requireIdentity")}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="qs">{t("quietStart")}</Label>
              <Select id="qs" value={quietStart} onChange={(e) => setQuietStart(e.target.value)}>
                <option value="">{t("none")}</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{t("hour", { hour: i })}</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="qe">{t("quietEnd")}</Label>
              <Select id="qe" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)}>
                <option value="">{t("none")}</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{t("hour", { hour: i })}</option>
                ))}
              </Select>
            </div>
          </div>
          <Button onClick={savePolicy} disabled={saving || !project}>
            <Save aria-hidden="true" className="h-4 w-4" /> {saving ? t("saving") : t("savePolicy")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5"><Upload aria-hidden="true" className="h-4 w-4" /> Firebase</CardTitle>
          <CardDescription>{project?.hasFirebase ? t("fbConfigured") : t("fbNotConfigured")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Field label={t("serviceAccountJson")}>
            <Textarea value={firebase} onChange={(e) => setFirebase(e.target.value)} placeholder='{"type":"service_account",...}' className="min-h-28 font-mono text-xs" />
          </Field>
          <Button size="sm" variant="outline" onClick={uploadFirebase} disabled={firebaseBusy || !firebase.trim()}>
            {firebaseBusy ? t("uploading") : t("upload")}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5"><Upload aria-hidden="true" className="h-4 w-4" /> {t("kakaoTitle")}</CardTitle>
          <CardDescription>{project?.hasKakao ? t("fbConfigured") : t("kakaoNotConfigured")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label={t("providerUrl")}>
            <Input
              type="url"
              inputMode="url"
              spellCheck={false}
              autoComplete="off"
              value={kakao.provider_url}
              onChange={(e) => setKakao({ ...kakao, provider_url: e.target.value })}
              placeholder="https://provider.example.com/…"
            />
          </Field>
          <Field label={t("apiKeyLabel")}>
            <Input spellCheck={false} autoComplete="off" value={kakao.api_key} onChange={(e) => setKakao({ ...kakao, api_key: e.target.value })} placeholder="api_key" />
          </Field>
          <Field label={t("senderKey")}>
            <Input spellCheck={false} autoComplete="off" value={kakao.sender_key} onChange={(e) => setKakao({ ...kakao, sender_key: e.target.value })} placeholder="sender_key" />
          </Field>
          <Button
            size="sm"
            variant="outline"
            onClick={uploadKakao}
            disabled={kakaoBusy || !kakao.provider_url || !kakao.api_key || !kakao.sender_key}
          >
            {kakaoBusy ? t("saving") : t("kakaoSave")}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
