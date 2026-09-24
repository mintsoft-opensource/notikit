"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Trash2, AlertTriangle, RotateCw, SearchX } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import {
  JourneyFields,
  cleanDraft,
  sameDraft,
  toDraft,
  validateDraft,
  type JourneyDraft,
  type Step,
  type StepErrors,
} from "@/components/console/journey-form";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";

type Journey = { id: string; name: string; steps: Step[]; createdAt: string };

export function JourneyDetail({ projectId, journeyId }: { projectId: string; journeyId: string }) {
  const t = useTranslations("journeys");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const router = useRouter();

  const [loaded, setLoaded] = React.useState<Journey | null>(null);
  const [activeRuns, setActiveRuns] = React.useState(0);
  const [exitedRuns, setExitedRuns] = React.useState(0);
  const [totalRuns, setTotalRuns] = React.useState(0);
  const [stepCounts, setStepCounts] = React.useState<Record<string, number>>({});
  const [missing, setMissing] = React.useState(false);
  /** 404 가 아닌 실패 — 스켈레톤을 영원히 돌리지 않고 오류와 재시도를 보인다 */
  const [failed, setFailed] = React.useState(false);
  const [name, setName] = React.useState("");
  const [draft, setDraft] = React.useState<JourneyDraft>(() => toDraft([]));
  /** 서버에 저장된 스텝을 드래프트로 — dirty 비교 기준. 렌더마다 rowId 를 새로 만들지 않게 불러올 때 한 번 만든다 */
  const [savedDraft, setSavedDraft] = React.useState<JourneyDraft>(() => toDraft([]));
  const [errors, setErrors] = React.useState<StepErrors>({});
  const [saving, setSaving] = React.useState(false);
  const reqRef = React.useRef(0);

  const apply = React.useCallback((journey: Journey) => {
    setLoaded(journey);
    setName(journey.name);
    const next = toDraft(journey.steps);
    setDraft(next);
    setSavedDraft(next);
    setErrors({});
  }, []);

  const load = React.useCallback(async () => {
    const my = ++reqRef.current;
    setFailed(false);
    try {
      const d = await adminApi<{
        journey: Journey;
        activeRuns: number;
        exitedRuns: number;
        totalRuns: number;
        stepCounts: Record<string, number>;
      }>(`/api/admin/projects/${projectId}/journeys/${journeyId}`);
      if (my !== reqRef.current) return;
      apply(d.journey);
      setActiveRuns(d.activeRuns);
      setExitedRuns(d.exitedRuns);
      setTotalRuns(d.totalRuns);
      setStepCounts(d.stepCounts ?? {});
    } catch (e) {
      if (my !== reqRef.current) return;
      // 404 는 "없음"으로, 나머지는 오류로 구분한다 — 지워진 것과 장애는 대응이 다르다
      if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
      else setFailed(true);
    }
  }, [projectId, journeyId, apply]);

  React.useEffect(() => {
    load();
    // 언마운트·대상 변경 후 도착한 응답은 버린다
    return () => { reqRef.current++; };
  }, [load]);

  // 이름은 잠겨 있으므로 스텝 변경만 본다
  const dirty = !!loaded && !sameDraft(draft, savedDraft);

  async function save() {
    if (saving) return;
    // 칸별 오류를 먼저 낸다 — 서버 422 를 토스트로만 보여 주면 어느 스텝이 문제인지 알 수 없다
    const found = validateDraft(draft, t);
    setErrors(found);
    const firstBad = Object.keys(found)[0];
    if (firstBad) {
      document.querySelector<HTMLElement>(`[data-row="${firstBad}"] input`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const d = await adminApi<{ journey: Journey }>(`/api/admin/projects/${projectId}/journeys/${journeyId}`, {
        method: "PATCH",
        body: JSON.stringify({ steps: cleanDraft(draft) }),
      });
      // 서버가 돌려준 값으로 되맞춘다 — 안 하면 dirty 가 영구히 true 로 남는다
      apply(d.journey);
      toast.success(tc("saved"));
    } catch (e) {
      toast.error(errorText(e, tc("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (saving) return;
    // 삭제는 진행 중 실행만이 아니라 **완료된 이력까지** cascade 로 지운다
    if (!confirm(totalRuns > 0 ? t("confirmRemoveRuns", { active: activeRuns, total: totalRuns }) : tc("confirmRemove"))) return;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/journeys/${journeyId}`, { method: "DELETE" });
      toast.success(tc("removed"));
      router.push(`/projects/${projectId}/journeys`);
    } catch (e) {
      toast.error(errorText(e, tc("removeFailed")));
      setSaving(false);
    }
  }

  const backHref = `/projects/${projectId}/journeys`;

  // "없음"과 "못 가져옴"은 둘 다 Card + EmptyState 한 벌로 낸다 — 한쪽만 카드 밖에 맨몸으로
  // 서 있으면 같은 자리에서 다른 화면처럼 보이고, 되돌아갈 버튼의 위치도 매번 달라진다.
  if (missing) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={tc("notFound")} />
        <Card>
          <EmptyState
            icon={SearchX}
            title={tc("notFound")}
            description={tc("notFoundDesc")}
            action={
              <Button asChild variant="outline">
                <Link href={backHref}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (failed && !loaded) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={t("title")} />
        <Card>
          <EmptyState
            icon={AlertTriangle}
            tone="error"
            title={tc("loadFailed")}
            description={tc("loadFailedDesc")}
            action={
              <Button variant="outline" onClick={load}>
                <RotateCw aria-hidden="true" className="size-4" /> {tc("retry")}
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="w-full space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={loaded.name}
        description={t("subtitle")}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href={backHref}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
            </Button>
            <Button variant="destructive" onClick={remove} disabled={saving}>
              <Trash2 aria-hidden="true" className="size-4" /> {tc("remove")}
            </Button>
          </>
        }
      />

      {/* 스텝을 고치면 이미 중간에 있는 유저의 다음 단계가 바뀐다. 누르기 전에 알아야 한다. */}
      {activeRuns > 0 && (
        // 카드와 같은 줄에 서는 블록이라 같은 반경·같은 여백. `destructive` 는 이 프로젝트에
        // 없는 색이라 테두리도 글자도 아무 색이 안 나왔다 — 상태색 토큰(error)으로 바꾼다.
        <div className="flex items-start gap-2 rounded-card border border-error/30 bg-error/5 p-3.5 text-sm">
          <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-error" />
          <span>{t("activeRunsWarning", { count: activeRuns })}</span>
        </div>
      )}

      <Card>
        <CardHeader><CardTitle>{tc("edit")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <JourneyFields
            idPrefix="journey"
            name={name}
            draft={draft}
            onName={setName}
            onDraft={setDraft}
            errors={errors}
            // 스텝별 인원을 편집 화면 안에 함께 둔다 — 표를 따로 두면 어느 줄이 어느 스텝인지 맞춰 봐야 한다
            stepCounts={stepCounts}
            nameLocked
            disabled={saving}
          />
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
          {/* 수는 로케일 규칙(자릿점)으로 찍고 tabular-nums 로 자릿수를 맞춘다 — String() 은
              12345 를 그대로 내보내 자리 수를 눈으로 세야 하고, 줄마다 폭이 달라진다 */}
          <DataRow label={t("activeRuns")} value={<span className="tabular-nums">{nf.format(activeRuns)}</span>} />
          <DataRow label={t("exitedRuns")} value={<span className="tabular-nums">{nf.format(exitedRuns)}</span>} />
          <DataRow label={t("totalRuns")} value={<span className="tabular-nums">{nf.format(totalRuns)}</span>} />
          <DataRow label={tc("createdAt")} value={new Date(loaded.createdAt).toLocaleString(locale)} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
