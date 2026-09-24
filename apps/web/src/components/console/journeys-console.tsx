"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Play, ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import {
  JourneyFields,
  EMPTY_STEPS,
  cleanDraft,
  sameDraft,
  toDraft,
  validateDraft,
  type JourneyDraft,
  type Step,
  type StepErrors,
} from "@/components/console/journey-form";
import { entryEventOf, normalizeSteps } from "@/lib/journey-steps";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";

type Journey = { id: string; name: string; steps: Step[] };

export function JourneysConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("journeys");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [journeys, setJourneys] = React.useState<Journey[]>([]);
  const [name, setName] = React.useState("");
  const [draft, setDraft] = React.useState<JourneyDraft>(() => toDraft(EMPTY_STEPS));
  const [errors, setErrors] = React.useState<StepErrors>({});
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return; // stale 호출(전환 후) 무시
      const my = ++reqRef.current;
      setJourneys([]);
      try {
        const d = await adminApi<{ journeys: Journey[] }>(`/api/admin/projects/${id}/journeys`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setJourneys(d.journeys);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(errorText(e, tc("loadFailed")));
      }
    },
    [tc]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
  }, [sel, load]);

  function close() {
    // 저장 중에 닫으면 결과가 어디에도 안 보인다 — 끝날 때까지 막는다
    if (saving) return;
    const dirty = name.trim() !== "" || !sameDraft(draft, toDraft(EMPTY_STEPS));
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    setName("");
    setDraft(toDraft(EMPTY_STEPS));
    setErrors({});
  }

  async function create() {
    if (!sel || !name.trim() || saving) return;
    // 칸별 오류를 먼저 낸다 — 서버 422 를 토스트로만 보여 주면 어느 스텝이 문제인지 알 수 없다
    const found = validateDraft(draft, t);
    setErrors(found);
    const firstBad = Object.keys(found)[0];
    if (firstBad) {
      document.querySelector<HTMLElement>(`[data-row="${firstBad}"] input`)?.focus();
      return;
    }
    const target = sel;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${target}/journeys`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), steps: cleanDraft(draft) }),
      });
      toast.success(t("created"));
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setDraft(toDraft(EMPTY_STEPS));
        setErrors({});
        setOpen(false);
        load(target);
      }
    } catch (e) {
      toast.error(errorText(e, t("createFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function process() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number }>(`/api/admin/projects/${sel}/journeys/process`, { method: "POST", body: "{}" });
      toast.success(t("processed", { count: d.processed }));
    } catch (e) {
      toast.error(errorText(e, t("processFailed")));
    }
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <>
            <Button variant="outline" onClick={process} disabled={!sel}>
              <Play aria-hidden="true" className="h-4 w-4" /> {t("processBtn")}
            </Button>
            {sel && (
              <Button onClick={() => setOpen(true)}>
                <Plus aria-hidden="true" className="h-4 w-4" /> {t("newJourney")}
              </Button>
            )}
          </>
        }
      />
      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      {sel && (
        <>
          <Dialog
            open={open}
            onClose={close}
            title={t("newJourney")}
            description={t("subtitle")}
            size="lg"
            footer={
              <>
                <Button variant="ghost" onClick={close} disabled={saving}>{tc("cancel")}</Button>
                <Button onClick={create} disabled={saving || !name.trim()}>{t("create")}</Button>
              </>
            }
          >
            <JourneyFields
              idPrefix="new-journey"
              name={name}
              draft={draft}
              onName={setName}
              onDraft={setDraft}
              errors={errors}
              disabled={saving}
            />
          </Dialog>

          <Card>
            <CardHeader><CardTitle>{t("listTitle", { count: journeys.length })}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {journeys.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
              {journeys.map((j) => (
                <Link
                  key={j.id}
                  href={`/projects/${sel}/journeys/${j.id}`}
                  aria-label={`${j.name} — ${tc("detail")}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2 transition-colors hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-semibold">{j.name}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden flex-wrap justify-end gap-1 sm:flex">
                      {/* 읽기 전용 목록이라 순서가 곧 정체성 — 인덱스 key 로 충분하다 */}
                      {summarize(j.steps).map((b, i) => (
                        <Badge key={i} variant={b.tone}>
                          {b.key === "stepWaitBadge" ? t(b.key, { hours: b.hours ?? 0 }) : t(b.key)}
                        </Badge>
                      ))}
                    </div>
                    <ChevronRight aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

type SummaryBadge = { key: "entryBadge" | "stepTypeSend" | "stepWaitBadge" | "stepTypeBranch" | "stepTypeExit"; tone: "primary" | "neutral" | "warning"; hours?: number };

/**
 * 목록의 한 줄 요약. 트리를 통째로 펼치면 줄이 끝없이 길어지므로 **루트 스텝만** 낸다 —
 * 분기 안쪽은 상세 화면에서 본다. 진입 트리거가 있으면 맨 앞에 알린다: 트리거 저니와
 * API 로만 들어오는 저니는 운영이 완전히 다르다.
 */
function summarize(steps: Step[]): SummaryBadge[] {
  const tree = normalizeSteps(steps);
  const out: SummaryBadge[] = [];
  if (entryEventOf(tree)) out.push({ key: "entryBadge", tone: "warning" });
  for (const s of tree) {
    if (s.type === "send") out.push({ key: "stepTypeSend", tone: "primary" });
    else if (s.type === "wait") out.push({ key: "stepWaitBadge", tone: "neutral", hours: s.hours ?? 0 });
    else if (s.type === "branch") out.push({ key: "stepTypeBranch", tone: "primary" });
    else if (s.type === "exit") out.push({ key: "stepTypeExit", tone: "neutral" });
  }
  return out;
}
