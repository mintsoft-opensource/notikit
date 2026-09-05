"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X, Play, Send, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Step = { type: "send" | "wait"; title?: string; body?: string; hours?: number };
type Journey = { id: string; name: string; steps: Step[] };

export default function JourneysPage() {
  const { projects } = useProjects();
  const [sel, setSel] = React.useState("");
  const [journeys, setJourneys] = React.useState<Journey[]>([]);
  const [name, setName] = React.useState("");
  const [steps, setSteps] = React.useState<Step[]>([{ type: "send", title: "", body: "" }]);
  const reqRef = React.useRef(0);

  const load = React.useCallback(
    async (id: string) => {
      if (!id) return;
      const my = ++reqRef.current;
      setJourneys([]);
      try {
        const d = await adminApi<{ journeys: Journey[] }>(`/api/admin/projects/${id}/journeys`);
        if (my !== reqRef.current) return;
        setJourneys(d.journeys);
      } catch (e) {
        if (my === reqRef.current) toast.error(e instanceof Error ? e.message : "로드 실패");
      }
    },
    []
  );

  React.useEffect(() => {
    if (sel) load(sel);
  }, [sel, load]);

  function updateStep(i: number, patch: Partial<Step>) {
    setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  async function create() {
    if (!sel || !name.trim()) return;
    const cleaned = steps.map((s) =>
      s.type === "send" ? { type: "send", title: s.title, body: s.body } : { type: "wait", hours: Number(s.hours) || 0 }
    );
    try {
      await adminApi(`/api/admin/projects/${sel}/journeys`, { method: "POST", body: JSON.stringify({ name: name.trim(), steps: cleaned }) });
      toast.success("저니 생성됨");
      setName("");
      setSteps([{ type: "send", title: "", body: "" }]);
      load(sel);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "생성 실패");
    }
  }

  async function process() {
    if (!sel) return;
    try {
      const d = await adminApi<{ processed: number }>(`/api/admin/projects/${sel}/journeys/process`, { method: "POST", body: "{}" });
      toast.success(`진행 ${d.processed}건`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "처리 실패");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="저니"
        description="다단계 워크플로 (send → wait → send)"
        actions={
          <Button variant="outline" size="sm" onClick={process} disabled={!sel}>
            <Play className="h-4 w-4" /> 진행 처리
          </Button>
        }
      />
      <ProjectPicker projects={projects} value={sel} onChange={setSel} />

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>새 저니</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label>이름</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: onboarding" />
              </div>
              <div className="space-y-2">
                <Label>스텝</Label>
                {steps.map((s, i) => (
                  <div key={i} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2">
                      <Select aria-label="스텝 타입" value={s.type} onChange={(e) => updateStep(i, { type: e.target.value as Step["type"] })} className="w-32">
                        <option value="send">send</option>
                        <option value="wait">wait</option>
                      </Select>
                      <span className="text-xs text-muted-foreground">스텝 {i + 1}</span>
                      <Button variant="ghost" size="icon" className="ml-auto" aria-label="스텝 삭제" onClick={() => setSteps(steps.filter((_, j) => j !== i))} disabled={steps.length === 1}>
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                    {s.type === "send" ? (
                      <div className="grid gap-2 sm:grid-cols-2">
                        <Input value={s.title ?? ""} onChange={(e) => updateStep(i, { title: e.target.value })} placeholder="제목" />
                        <Input value={s.body ?? ""} onChange={(e) => updateStep(i, { body: e.target.value })} placeholder="본문" />
                      </div>
                    ) : (
                      <Input
                        type="number"
                        min={0}
                        max={8760}
                        value={s.hours ?? ""}
                        onChange={(e) => updateStep(i, { hours: Number(e.target.value) })}
                        placeholder="대기 시간(시간)"
                      />
                    )}
                  </div>
                ))}
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { type: "send", title: "", body: "" }])}>
                    <Send className="h-4 w-4" /> send 추가
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setSteps([...steps, { type: "wait", hours: 24 }])}>
                    <Clock className="h-4 w-4" /> wait 추가
                  </Button>
                </div>
              </div>
              <Button onClick={create} disabled={!name.trim()}>저니 생성</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>저니 ({journeys.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {journeys.length === 0 && <p className="text-sm text-muted-foreground">없음</p>}
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
