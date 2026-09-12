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
import { JourneyFields, EMPTY_STEPS, cleanSteps, type Step } from "@/components/console/journey-form";
import { useProjects, adminApi } from "@/lib/admin-client";

type Journey = { id: string; name: string; steps: Step[] };

export function JourneysConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("journeys");
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [journeys, setJourneys] = React.useState<Journey[]>([]);
  const [name, setName] = React.useState("");
  const [steps, setSteps] = React.useState<Step[]>(EMPTY_STEPS);
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
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    },
    [tc]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
  }, [sel, load]);

  function close() {
    const dirty = name.trim() !== "" || JSON.stringify(steps) !== JSON.stringify(EMPTY_STEPS);
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    setName("");
    setSteps(EMPTY_STEPS);
  }

  async function create() {
    if (!sel || !name.trim() || saving) return;
    const target = sel;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${target}/journeys`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), steps: cleanSteps(steps) }),
      });
      toast.success(t("created"));
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setSteps(EMPTY_STEPS);
        setOpen(false);
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("createFailed"));
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
      toast.error(e instanceof Error ? e.message : t("processFailed"));
    }
  }

  return (
    <div className="space-y-3">
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
                <Button variant="ghost" onClick={close}>{tc("cancel")}</Button>
                <Button onClick={create} disabled={saving || !name.trim()}>{t("create")}</Button>
              </>
            }
          >
            <JourneyFields idPrefix="new-journey" name={name} steps={steps} onName={setName} onSteps={setSteps} />
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
                      {j.steps.map((s, i) => (
                        <Badge key={i} variant={s.type === "send" ? "primary" : "neutral"}>
                          {s.type === "send" ? "send" : `wait ${s.hours ?? 0}h`}
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
