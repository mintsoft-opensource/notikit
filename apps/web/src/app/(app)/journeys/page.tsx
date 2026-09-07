"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X, Play, Send, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Step = { type: "send" | "wait"; title?: string; body?: string; hours?: number };
type Journey = { id: string; name: string; steps: Step[] };

export default function JourneysPage() {
  const t = useTranslations("journeys");
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [sel, setSel] = React.useState("");
  const [journeys, setJourneys] = React.useState<Journey[]>([]);
  const [name, setName] = React.useState("");
  const [steps, setSteps] = React.useState<Step[]>([{ type: "send", title: "", body: "" }]);
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

  function updateStep(i: number, patch: Partial<Step>) {
    setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  async function create() {
    if (!sel || !name.trim()) return;
    const target = sel;
    const cleaned = steps.map((s) =>
      s.type === "send" ? { type: "send", title: s.title, body: s.body } : { type: "wait", hours: Number(s.hours) || 0 }
    );
    try {
      await adminApi(`/api/admin/projects/${target}/journeys`, { method: "POST", body: JSON.stringify({ name: name.trim(), steps: cleaned }) });
      toast.success(t("created"));
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setSteps([{ type: "send", title: "", body: "" }]);
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("createFailed"));
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
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={process} disabled={!sel}>
            <Play aria-hidden="true" className="h-4 w-4" /> {t("processBtn")}
          </Button>
        }
      />
      <ProjectPicker projects={projects} value={sel} onChange={setSel} />

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>{t("newJourney")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label={t("nameLabel")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
              </Field>
              <div className="space-y-2">
                <Label>{t("stepsLabel")}</Label>
                {steps.map((s, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <Select aria-label={t("stepType")} value={s.type} onChange={(e) => updateStep(i, { type: e.target.value as Step["type"] })} className="w-32">
                        <option value="send">send</option>
                        <option value="wait">wait</option>
                      </Select>
                      <span className="text-xs text-muted-foreground">{t("stepN", { n: i + 1 })}</span>
                      <Button variant="ghost" size="icon" className="ml-auto" aria-label={t("removeStep")} onClick={() => setSteps(steps.filter((_, j) => j !== i))} disabled={steps.length === 1}>
                        <X aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    </div>
                    {s.type === "send" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input value={s.title ?? ""} onChange={(e) => updateStep(i, { title: e.target.value })} placeholder={t("titlePlaceholder")} />
                        <Input value={s.body ?? ""} onChange={(e) => updateStep(i, { body: e.target.value })} placeholder={t("bodyPlaceholder")} />
                      </div>
                    ) : (
                      <Input
                        type="number"
                        min={0}
                        max={8760}
                        value={s.hours ?? ""}
                        onChange={(e) => updateStep(i, { hours: Number(e.target.value) })}
                        placeholder={t("waitHoursPlaceholder")}
                      />
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { type: "send", title: "", body: "" }])}>
                    <Send aria-hidden="true" className="h-4 w-4" /> {t("addSend")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { type: "wait", hours: 24 }])}>
                    <Clock aria-hidden="true" className="h-4 w-4" /> {t("addWait")}
                  </Button>
                </div>
              </div>
              <Button onClick={create} disabled={!name.trim()}>{t("create")}</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("listTitle", { count: journeys.length })}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {journeys.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
              {journeys.map((j) => (
                <div key={j.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <span className="text-sm font-semibold">{j.name}</span>
                  <div className="flex flex-wrap gap-1">
                    {j.steps.map((s, i) => (
                      <Badge key={i} variant={s.type === "send" ? "primary" : "neutral"}>
                        {s.type === "send" ? "send" : `wait ${s.hours ?? 0}h`}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
