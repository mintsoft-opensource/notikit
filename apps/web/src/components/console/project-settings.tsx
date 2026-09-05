"use client";

import * as React from "react";
import { toast } from "sonner";
import { Save, Upload } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi } from "@/lib/admin-client";

/** 프로젝트 설정 — 발송 정책(identity/방해금지) + Firebase/카카오 자격증명. 프로젝트 상세 전용. */
export function ProjectSettings({ projectId }: { projectId: string }) {
  const { projects, reload } = useProjects();
  const project = projects.find((p) => p.id === projectId);

  const [quietStart, setQuietStart] = React.useState("");
  const [quietEnd, setQuietEnd] = React.useState("");
  const [requireId, setRequireId] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const hydrated = React.useRef(false);

  React.useEffect(() => {
    if (hydrated.current || !project) return;
    setRequireId(project.requireIdentityVerification ?? true);
    setQuietStart(project.quietStartHour == null ? "" : String(project.quietStartHour));
    setQuietEnd(project.quietEndHour == null ? "" : String(project.quietEndHour));
    hydrated.current = true;
  }, [project]);

  const [firebase, setFirebase] = React.useState("");

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
      toast.success("정책 저장됨");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  async function uploadFirebase() {
    let creds: unknown;
    try {
      creds = JSON.parse(firebase);
    } catch {
      toast.error("JSON 파싱 실패");
      return;
    }
    try {
      const d = await adminApi<{ firebase_project_id?: string }>(`/api/admin/projects/${projectId}/firebase`, {
        method: "POST",
        body: JSON.stringify({ credentials: creds }),
      });
      toast.success(`Firebase 저장됨${d.firebase_project_id ? ` (${d.firebase_project_id})` : ""}`);
      setFirebase("");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "실패");
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader title="설정" description="발송 정책 · Firebase/카카오 자격증명" />

      <Card>
        <CardHeader>
          <CardTitle>발송 정책</CardTitle>
          <CardDescription>identity 검증 강제 · 방해금지 시간대(UTC).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={requireId} onChange={(e) => setRequireId(e.target.checked)} className="h-4 w-4" />
            external_id 바인딩에 identity_hash 검증 강제
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="qs">방해금지 시작 (UTC)</Label>
              <Select id="qs" value={quietStart} onChange={(e) => setQuietStart(e.target.value)}>
                <option value="">없음</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i}시</option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="qe">방해금지 종료 (UTC)</Label>
              <Select id="qe" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)}>
                <option value="">없음</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={i}>{i}시</option>
                ))}
              </Select>
            </div>
          </div>
          <Button onClick={savePolicy} disabled={saving || !project}>
            <Save className="h-4 w-4" /> {saving ? "저장 중…" : "정책 저장"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5"><Upload className="h-4 w-4" /> Firebase</CardTitle>
          <CardDescription>{project?.hasFirebase ? "설정됨 (재업로드 시 교체)" : "미설정 — log-only 모드"}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Field label="서비스 계정 JSON">
            <Textarea value={firebase} onChange={(e) => setFirebase(e.target.value)} placeholder='{"type":"service_account",...}' className="min-h-28 font-mono text-xs" />
          </Field>
          <Button size="sm" variant="outline" onClick={uploadFirebase} disabled={!firebase.trim()}>업로드 · 암호화 저장</Button>
        </CardContent>
      </Card>
    </div>
  );
}
