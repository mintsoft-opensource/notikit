"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Field } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { useProjects, adminApi } from "@/lib/admin-client";

type Rule = { attribute: string; value: string };
type Segment = { id: string; name: string; rules: Rule[] };

export default function SegmentsPage() {
  const { projects } = useProjects();
  const [sel, setSel] = React.useState("");
  const [segments, setSegments] = React.useState<Segment[]>([]);
  const [name, setName] = React.useState("");
  const [rules, setRules] = React.useState<Rule[]>([{ attribute: "", value: "" }]);
  const reqRef = React.useRef(0);
  const selRef = React.useRef(sel);

  const load = React.useCallback(
    async (id: string) => {
      if (!id || id !== selRef.current) return; // stale 호출(전환 후) 무시
      const my = ++reqRef.current;
      setSegments([]);
      try {
        const d = await adminApi<{ segments: Segment[] }>(`/api/admin/projects/${id}/segments`);
        if (my !== reqRef.current || id !== selRef.current) return;
        setSegments(d.segments);
      } catch (e) {
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : "로드 실패");
      }
    },
    []
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
  }, [sel, load]);

  async function create() {
    if (!sel || !name.trim()) return;
    const target = sel;
    const cleaned = rules.filter((r) => r.attribute.trim() && r.value.trim());
    try {
      await adminApi(`/api/admin/projects/${target}/segments`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), rules: cleaned }),
      });
      toast.success("세그먼트 생성됨");
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setRules([{ attribute: "", value: "" }]);
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "생성 실패");
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="세그먼트" description="유저 속성 동등 매칭 규칙으로 대상 그룹 정의" />
      <ProjectPicker projects={projects} value={sel} onChange={setSel} />

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>새 세그먼트</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label="이름">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: pro-users" />
              </Field>
              <div className="space-y-2">
                <Label>속성 규칙 (attribute = value)</Label>
                {rules.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={r.attribute}
                      onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, attribute: e.target.value } : x)))}
                      placeholder="attribute (예: plan)"
                    />
                    <span className="text-muted-foreground">=</span>
                    <Input
                      value={r.value}
                      onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      placeholder="value (예: pro)"
                    />
                    <Button variant="ghost" size="icon" aria-label="규칙 삭제" onClick={() => setRules(rules.filter((_, j) => j !== i))} disabled={rules.length === 1}>
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setRules([...rules, { attribute: "", value: "" }])}>
                  <Plus className="h-4 w-4" /> 규칙 추가
                </Button>
              </div>
              <Button onClick={create} disabled={!name.trim()}>세그먼트 생성</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>세그먼트 ({segments.length})</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {segments.length === 0 && <p className="text-sm text-muted-foreground">없음</p>}
              {segments.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <span className="text-sm font-semibold">{s.name}</span>
                  <div className="flex flex-wrap gap-1">
                    {s.rules.map((r, i) => (
                      <Badge key={i} variant="neutral">{r.attribute}={r.value}</Badge>
                    ))}
                    {s.rules.length === 0 && <span className="text-xs text-muted-foreground">규칙 없음</span>}
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
