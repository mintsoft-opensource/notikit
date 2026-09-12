"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Trash2, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { PageHeader } from "@/components/layout/page-header";
import { JourneyFields, EMPTY_STEPS, cleanSteps, type Step } from "@/components/console/journey-form";
import { adminApi } from "@/lib/admin-client";

type Journey = { id: string; name: string; steps: Step[]; createdAt: string };

export function JourneyDetail({ projectId, journeyId }: { projectId: string; journeyId: string }) {
  const t = useTranslations("journeys");
  const tc = useTranslations("common");
  const router = useRouter();

  const [loaded, setLoaded] = React.useState<Journey | null>(null);
  const [activeRuns, setActiveRuns] = React.useState(0);
  const [totalRuns, setTotalRuns] = React.useState(0);
  const [missing, setMissing] = React.useState(false);
  const [name, setName] = React.useState("");
  const [steps, setSteps] = React.useState<Step[]>(EMPTY_STEPS);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const d = await adminApi<{ journey: Journey; activeRuns: number; totalRuns: number }>(
          `/api/admin/projects/${projectId}/journeys/${journeyId}`
        );
        if (stale) return;
        setLoaded(d.journey);
        setActiveRuns(d.activeRuns);
        setTotalRuns(d.totalRuns);
        setName(d.journey.name);
        setSteps(d.journey.steps.length ? d.journey.steps : EMPTY_STEPS);
      } catch (e) {
        if (stale) return;
        // 404 는 "없음"으로, 나머지는 오류로 구분한다 — 지워진 것과 장애는 대응이 다르다
        if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
        else toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    })();
    return () => { stale = true; };
  }, [projectId, journeyId, tc]);

  // 이름은 잠겨 있으므로 스텝 변경만 본다
  const dirty =
    !!loaded && JSON.stringify(cleanSteps(steps)) !== JSON.stringify(cleanSteps(loaded.steps));

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const d = await adminApi<{ journey: Journey }>(`/api/admin/projects/${projectId}/journeys/${journeyId}`, {
        method: "PATCH",
        body: JSON.stringify({ steps: cleanSteps(steps) }),
      });
      setLoaded(d.journey);
      // 서버가 돌려준 값으로 되맞춘다 — 안 하면 dirty 가 영구히 true 로 남는다
      setName(d.journey.name);
      setSteps(d.journey.steps.length ? d.journey.steps : EMPTY_STEPS);
      toast.success(tc("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // 삭제는 진행 중 실행만이 아니라 **완료된 이력까지** cascade 로 지운다
    if (!confirm(totalRuns > 0 ? t("confirmRemoveRuns", { active: activeRuns, total: totalRuns }) : tc("confirmRemove"))) return;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/journeys/${journeyId}`, { method: "DELETE" });
      toast.success(tc("removed"));
      router.push(`/projects/${projectId}/journeys`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("removeFailed"));
      setSaving(false);
    }
  }

  const backHref = `/projects/${projectId}/journeys`;

  if (missing) {
    return (
      <div className="space-y-3">
        <PageHeader title={tc("notFound")} />
        <Button asChild variant="outline">
          <Link href={backHref}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
        </Button>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={loaded.name}
        description={t("subtitle")}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href={backHref}><ArrowLeft aria-hidden="true" className="h-4 w-4" /> {tc("back")}</Link>
            </Button>
            <Button variant="destructive" onClick={remove} disabled={saving}>
              <Trash2 aria-hidden="true" className="h-4 w-4" /> {tc("remove")}
            </Button>
          </>
        }
      />

      {/* 스텝을 고치면 이미 중간에 있는 유저의 다음 단계가 바뀐다. 누르기 전에 알아야 한다. */}
      {activeRuns > 0 && (
        <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-3 text-sm">
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-destructive" />
          <span>{t("activeRunsWarning", { count: activeRuns })}</span>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{tc("edit")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <JourneyFields idPrefix="journey" name={name} steps={steps} onName={setName} onSteps={setSteps} nameLocked />
          <div className="flex justify-end">
            {/* 바뀐 게 없으면 비활성 — 누르면 저장된 것처럼 보이지만 아무 일도 안 일어난다 */}
            <Button onClick={save} disabled={saving || !dirty}>{tc("save")}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-3.5">
          {/* DataRow 는 dt/dd 를 낸다 — dl 로 감싸지 않으면 정의목록 의미가 사라진다 */}
          <dl className="space-y-1">
          <DataRow label="ID" value={loaded.id} />
          <DataRow label={t("activeRuns")} value={String(activeRuns)} />
          <DataRow label={t("totalRuns")} value={String(totalRuns)} />
          <DataRow label={tc("createdAt")} value={new Date(loaded.createdAt).toLocaleString()} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
