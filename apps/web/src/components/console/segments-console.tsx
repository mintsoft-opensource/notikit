"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
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

export function SegmentsConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("segments");
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
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
        if (my === reqRef.current && id === selRef.current) toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    },
    [tc]
  );

  React.useEffect(() => {
    selRef.current = sel;
    if (sel) load(sel);
  }, [sel, load]);

  async function create() {
    if (!sel || !name.trim()) return;
    const target = sel;
    // 한쪽만 채운 규칙은 오류 (조용히 버려져 전체 발송으로 넓어지는 것 방지)
    const partial = rules.some((r) => Boolean(r.attribute.trim()) !== Boolean(r.value.trim()));
    if (partial) {
      toast.error(t("partialRule"));
      return;
    }
    const cleaned = rules.filter((r) => r.attribute.trim() && r.value.trim());
    if (cleaned.length === 0 && !confirm(t("confirmNoRules"))) return;
    try {
      await adminApi(`/api/admin/projects/${target}/segments`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), rules: cleaned }),
      });
      toast.success(t("created"));
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setRules([{ attribute: "", value: "" }]);
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("createFailed"));
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("subtitle")} />
      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      {sel && (
        <>
          <Card>
            <CardHeader><CardTitle>{t("newSegment")}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Field label={t("nameLabel")}>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("namePlaceholder")} />
              </Field>
              <div className="space-y-2">
                <Label>{t("rulesLabel")}</Label>
                {rules.map((r, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={r.attribute}
                      onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, attribute: e.target.value } : x)))}
                      placeholder={t("attributePlaceholder")}
                    />
                    <span className="text-muted-foreground">=</span>
                    <Input
                      value={r.value}
                      onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                      placeholder={t("valuePlaceholder")}
                    />
                    <Button variant="ghost" size="icon" aria-label={t("removeRule")} onClick={() => setRules(rules.filter((_, j) => j !== i))} disabled={rules.length === 1}>
                      <X aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
                <Button variant="outline" size="sm" onClick={() => setRules([...rules, { attribute: "", value: "" }])}>
                  <Plus aria-hidden="true" className="h-4 w-4" /> {t("addRule")}
                </Button>
              </div>
              <Button onClick={create} disabled={!name.trim()}>{t("create")}</Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>{t("listTitle", { count: segments.length })}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {segments.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
              {segments.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-border px-4 py-3">
                  <span className="text-sm font-semibold">{s.name}</span>
                  <div className="flex flex-wrap gap-1">
                    {s.rules.map((r, i) => (
                      <Badge key={i} variant="neutral">{r.attribute}={r.value}</Badge>
                    ))}
                    {s.rules.length === 0 && <span className="text-xs text-muted-foreground">{t("noRules")}</span>}
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
