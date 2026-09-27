"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Save, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { FIELD_ERROR_TEXT, Field, Input, Label, Select, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";

type Policy = {
  requireIdentityVerification?: boolean;
  quietStartHour: number | null;
  quietEndHour: number | null;
  frequencyCapPerDay?: number | null;
  /** 분당 발송 상한(기기 수). null 이면 제한 없음 */
  maxSendsPerMinute?: number | null;
};

const FREQ_CAP_MIN = 1;
const FREQ_CAP_MAX = 100;
const RATE_MIN = 1;
const RATE_MAX = 100_000;

/** 비움(=제한 없음)과 잘못된 값을 가른다 — 둘을 섞으면 상한을 끌 수가 없다 */
function capState(raw: string, min: number, max: number): { value: number | null; invalid: boolean } {
  if (raw.trim() === "") return { value: null, invalid: false };
  const n = Number(raw);
  return { value: n, invalid: !Number.isInteger(n) || n < min || n > max };
}

/** 프로젝트 설정 — 발송 정책(identity/방해금지) + Firebase/카카오 자격증명. 프로젝트 상세 전용. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const errorText = useAdminErrorText();
  const { projects, reload } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const [quietStart, setQuietStart] = React.useState("");
  const [quietEnd, setQuietEnd] = React.useState("");
  const [requireId, setRequireId] = React.useState(true);
  const [freqCap, setFreqCap] = React.useState("");
  const [rateCap, setRateCap] = React.useState("");
  const [policyLoaded, setPolicyLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setPolicyLoaded(false);
    adminApi<{ project: Policy }>(`/api/admin/projects/${projectId}`)
      .then(({ project: p }) => {
        if (!alive) return;
        setRequireId(p.requireIdentityVerification ?? true);
        setQuietStart(p.quietStartHour == null ? "" : String(p.quietStartHour));
        setQuietEnd(p.quietEndHour == null ? "" : String(p.quietEndHour));
        setFreqCap(p.frequencyCapPerDay == null ? "" : String(p.frequencyCapPerDay));
        setRateCap(p.maxSendsPerMinute == null ? "" : String(p.maxSendsPerMinute));
        setPolicyLoaded(true);
      })
      .catch((e) => {
        if (alive) toast.error(errorText(e, tc("loadFailed")));
      });
    return () => { alive = false; };
  }, [projectId, errorText, tc]);

  const freq = capState(freqCap, FREQ_CAP_MIN, FREQ_CAP_MAX);
  const rate = capState(rateCap, RATE_MIN, RATE_MAX);
  const freqCapInvalid = freq.invalid;

  const [firebase, setFirebase] = React.useState("");
  const [firebaseBusy, setFirebaseBusy] = React.useState(false);
  const [kakao, setKakao] = React.useState({ provider_url: "", api_key: "", sender_key: "" });
  const [kakaoBusy, setKakaoBusy] = React.useState(false);

  async function savePolicy() {
    if (saving) return;
    if (freq.invalid) {
      toast.error(t("frequencyCapInvalid", { min: FREQ_CAP_MIN, max: FREQ_CAP_MAX }));
      return;
    }
    if (rate.invalid) {
      toast.error(t("rateCapInvalid", { min: RATE_MIN, max: RATE_MAX }));
      return;
    }
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify({
          require_identity_verification: requireId,
          quiet_start_hour: quietStart === "" ? null : Number(quietStart),
          quiet_end_hour: quietEnd === "" ? null : Number(quietEnd),
          frequency_cap_per_day: freq.value,
          max_sends_per_minute: rate.value,
        }),
      });
      toast.success(t("policySaved"));
      reload();
    } catch (e) {
      toast.error(errorText(e, t("saveFailed")));
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
      toast.error(errorText(e, t("failed")));
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
      toast.error(errorText(e, t("failed")));
    } finally {
      setKakaoBusy(false);
    }
  }

  const [tab, setTab] = React.useState<"policy" | "firebase" | "kakao">("policy");

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Tabs
        idPrefix="project-settings"
        label={t("title")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "policy", label: t("policyTitle") },
          { value: "firebase", label: "Firebase", icon: <Upload aria-hidden="true" className="size-4" /> },
          { value: "kakao", label: t("kakaoTitle"), icon: <Upload aria-hidden="true" className="size-4" /> },
        ]}
      />

      {tab === "policy" && (
      <TabPanel idPrefix="project-settings" value="policy">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{t("policyTitle")}</CardTitle>
            <CardDescription>{t("policyDesc")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex min-h-9 items-center gap-2 text-sm">
            <input type="checkbox" checked={requireId} onChange={(e) => setRequireId(e.target.checked)} className="size-4 rounded-sm border-border accent-[var(--primary)]" />
            {t("requireIdentity")}
          </label>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
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
            <div className="space-y-1">
              <Field label={t("frequencyCap")} hint={t("frequencyCapHint", { min: FREQ_CAP_MIN, max: FREQ_CAP_MAX })}>
                <Input
                  id="freq-cap"
                  type="number"
                  inputMode="numeric"
                  min={FREQ_CAP_MIN}
                  max={FREQ_CAP_MAX}
                  step={1}
                  value={freqCap}
                  onChange={(e) => setFreqCap(e.target.value)}
                  placeholder={t("none")}
                  aria-invalid={freqCapInvalid || undefined}
                  aria-describedby={freqCapInvalid ? "freq-cap-error" : undefined}
                />
              </Field>
              {freqCapInvalid && (
                <p id="freq-cap-error" className={FIELD_ERROR_TEXT}>
                  {t("frequencyCapInvalid", { min: FREQ_CAP_MIN, max: FREQ_CAP_MAX })}
                </p>
              )}
            </div>
            {/* 분당 상한은 하루 상한 바로 옆에 둔다 — 둘 다 "얼마나 자주 나가는가"를 정하는 값이다 */}
            <div className="space-y-1">
              <Field label={t("rateCap")} hint={t("rateCapHint", { min: RATE_MIN, max: RATE_MAX })}>
                <Input
                  id="rate-cap"
                  type="number"
                  inputMode="numeric"
                  min={RATE_MIN}
                  max={RATE_MAX}
                  step={1}
                  value={rateCap}
                  onChange={(e) => setRateCap(e.target.value)}
                  placeholder={t("rateCapUnlimited")}
                  aria-invalid={rate.invalid || undefined}
                  aria-describedby={rate.invalid ? "rate-cap-error" : undefined}
                />
              </Field>
              {rate.invalid && (
                <p id="rate-cap-error" className={FIELD_ERROR_TEXT}>
                  {t("rateCapInvalid", { min: RATE_MIN, max: RATE_MAX })}
                </p>
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={savePolicy} disabled={saving || !policyLoaded || freq.invalid || rate.invalid}>
              <Save aria-hidden="true" className="size-4" /> {saving ? t("saving") : t("savePolicy")}
            </Button>
          </div>
        </CardContent>
      </Card>
      </TabPanel>
      )}

      {tab === "firebase" && (
      <TabPanel idPrefix="project-settings" value="firebase">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5"><Upload aria-hidden="true" className="size-4" /> Firebase</CardTitle>
              <CardDescription>{project?.hasFirebase ? t("fbConfigured") : t("fbNotConfigured")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label={t("serviceAccountJson")}>
              <Textarea value={firebase} onChange={(e) => setFirebase(e.target.value)} placeholder='{"type":"service_account",...}' className="min-h-40 font-mono text-xs" />
            </Field>
            <Button size="sm" variant="outline" onClick={uploadFirebase} disabled={firebaseBusy || !firebase.trim()}>
              {firebaseBusy ? t("uploading") : t("upload")}
            </Button>
          </CardContent>
        </Card>
      </TabPanel>
      )}

      {tab === "kakao" && (
      <TabPanel idPrefix="project-settings" value="kakao">
        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-1.5"><Upload aria-hidden="true" className="size-4" /> {t("kakaoTitle")}</CardTitle>
              <CardDescription>{project?.hasKakao ? t("fbConfigured") : t("kakaoNotConfigured")}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
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
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("apiKeyLabel")}>
                <Input spellCheck={false} autoComplete="off" value={kakao.api_key} onChange={(e) => setKakao({ ...kakao, api_key: e.target.value })} placeholder="api_key" />
              </Field>
              <Field label={t("senderKey")}>
                <Input spellCheck={false} autoComplete="off" value={kakao.sender_key} onChange={(e) => setKakao({ ...kakao, sender_key: e.target.value })} placeholder="sender_key" />
              </Field>
            </div>
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
      </TabPanel>
      )}
    </div>
  );
}
