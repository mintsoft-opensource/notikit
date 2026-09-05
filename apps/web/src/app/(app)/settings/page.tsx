"use client";

import * as React from "react";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useAdminToken, useProjects, adminApi } from "@/lib/admin-client";

export default function SettingsPage() {
  const { token, ready, save } = useAdminToken();
  const [draft, setDraft] = React.useState("");
  const { projects } = useProjects(token, ready);
  const [sel, setSel] = React.useState("");
  const [quietStart, setQuietStart] = React.useState("");
  const [quietEnd, setQuietEnd] = React.useState("");
  const [requireId, setRequireId] = React.useState(true);

  React.useEffect(() => setDraft(token), [token]);

  function saveToken() {
    save(draft.trim());
    toast.success("관리자 토큰 저장됨");
  }

  async function saveProjectSettings() {
    if (!sel) return;
    try {
      await adminApi(`/api/admin/projects/${sel}`, token, {
        method: "PATCH",
        body: JSON.stringify({
          require_identity_verification: requireId,
          quiet_start_hour: quietStart === "" ? null : Number(quietStart),
          quiet_end_hour: quietEnd === "" ? null : Number(quietEnd),
        }),
      });
      toast.success("프로젝트 설정 저장됨");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    }
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title="설정" description="관리자 토큰과 프로젝트별 발송 정책을 관리합니다." />

      <Card>
        <CardHeader>
          <CardTitle>관리자 토큰</CardTitle>
          <CardDescription>Web Admin API 인증에 사용됩니다. 브라우저 localStorage 에만 저장됩니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="x-admin-token" type="password" />
          <Button onClick={saveToken} className="shrink-0">
            <Save className="h-4 w-4" /> 저장
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>프로젝트 발송 정책</CardTitle>
          <CardDescription>identity 검증 강제 · 방해금지 시간대(UTC 기준).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ProjectPicker projects={projects} value={sel} onChange={setSel} />
          {sel && (
            <div className="space-y-4 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={requireId} onChange={(e) => setRequireId(e.target.checked)} className="h-4 w-4" />
                external_id 바인딩에 identity_hash 검증 강제
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>방해금지 시작 (0–23, UTC)</Label>
                  <Select value={quietStart} onChange={(e) => setQuietStart(e.target.value)}>
                    <option value="">없음</option>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{i}시</option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>방해금지 종료 (0–23, UTC)</Label>
                  <Select value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)}>
                    <option value="">없음</option>
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>{i}시</option>
                    ))}
                  </Select>
                </div>
              </div>
              <Button onClick={saveProjectSettings}>
                <Save className="h-4 w-4" /> 정책 저장
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
