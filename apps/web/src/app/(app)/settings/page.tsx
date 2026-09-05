"use client";

import * as React from "react";
import { toast } from "sonner";
import { Save, LogOut, UserCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, useSession, adminApi, logout } from "@/lib/admin-client";

export default function SettingsPage() {
  const { user } = useSession();
  const { projects, reload } = useProjects();
  const [sel, setSel] = React.useState("");
  const [quietStart, setQuietStart] = React.useState("");
  const [quietEnd, setQuietEnd] = React.useState("");
  const [requireId, setRequireId] = React.useState(true);
  const [hydrated, setHydrated] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const hydratedFor = React.useRef<string>("");

  // 선택 프로젝트가 바뀔 때만 1회 하이드레이션 — projects 재로드(저장 후 등)로는 폼을 덮어쓰지 않음
  React.useEffect(() => {
    if (!sel) {
      hydratedFor.current = "";
      setHydrated(false);
      return;
    }
    if (hydratedFor.current === sel) return; // 이미 이 프로젝트로 하이드레이트됨 → 편집 보존
    const p = projects.find((x) => x.id === sel);
    if (!p) return; // projects 아직 로드 전 → 도착하면 재실행되어 하이드레이트
    setRequireId(p.requireIdentityVerification ?? true);
    setQuietStart(p.quietStartHour == null ? "" : String(p.quietStartHour));
    setQuietEnd(p.quietEndHour == null ? "" : String(p.quietEndHour));
    hydratedFor.current = sel;
    setHydrated(true);
  }, [sel, projects]);

  async function saveProjectSettings() {
    if (!sel || !hydrated || saving) return; // 직렬화: 동시 저장 방지(reorder 로 인한 값 불일치 차단)
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${sel}`, {
        method: "PATCH",
        body: JSON.stringify({
          require_identity_verification: requireId,
          quiet_start_hour: quietStart === "" ? null : Number(quietStart),
          quiet_end_hour: quietEnd === "" ? null : Number(quietEnd),
        }),
      });
      toast.success("프로젝트 설정 저장됨");
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <PageHeader title="설정" description="계정과 프로젝트별 발송 정책을 관리합니다." />

      <Card>
        <CardHeader>
          <CardTitle>계정</CardTitle>
          <CardDescription>현재 로그인한 관리자 계정입니다.</CardDescription>
        </CardHeader>
        <CardContent className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-primary">
              <UserCircle className="h-5 w-5" />
            </span>
            <div>
              <p className="text-sm font-semibold">{user?.email ?? "…"}</p>
              <p className="text-xs text-muted-foreground">{user?.role ?? ""}</p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                await logout();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "로그아웃 실패");
              }
            }}
          >
            <LogOut className="h-4 w-4" /> 로그아웃
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
              <Button onClick={saveProjectSettings} disabled={!hydrated || saving}>
                <Save className="h-4 w-4" /> {saving ? "저장 중…" : "정책 저장"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
