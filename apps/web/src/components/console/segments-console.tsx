"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ChevronRight, Plus } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { PageHeader } from "@/components/layout/page-header";
import { ProjectPicker } from "@/components/console/shared";
import { SegmentFields, EMPTY_RULES, cleanRules, type Rule } from "@/components/console/segment-form";
import { useProjects, adminApi } from "@/lib/admin-client";

type Segment = { id: string; name: string; rules: Rule[] };

export function SegmentsConsole({ projectId }: { projectId?: string }) {
  const t = useTranslations("segments");
  const tc = useTranslations("common");
  const { projects } = useProjects();
  const [picked, setPicked] = React.useState("");
  const sel = projectId ?? picked;
  const [segments, setSegments] = React.useState<Segment[]>([]);
  const [name, setName] = React.useState("");
  const [rules, setRules] = React.useState<Rule[]>(EMPTY_RULES);
  const [open, setOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
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

  function close() {
    // 입력하다 실수로 닫으면 다시 치게 되므로 확인을 받는다
    const dirty = name.trim() !== "" || rules.some((r) => r.attribute.trim() || r.value.trim());
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    setName("");
    setRules(EMPTY_RULES);
  }

  async function create() {
    if (!sel || !name.trim() || saving) return;
    const target = sel;
    const cleaned = cleanRules(rules, { partial: t("partialRule"), confirmNoRules: t("confirmNoRules") }, toast.error);
    if (!cleaned) return;

    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${target}/segments`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), rules: cleaned }),
      });
      toast.success(t("created"));
      // 완료 시점에 다른 프로젝트로 전환됐으면 B 의 드래프트를 지우지 않음
      if (selRef.current === target) {
        setName("");
        setRules(EMPTY_RULES);
        setOpen(false);
        load(target);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("createFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          sel ? (
            <Button onClick={() => setOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" /> {t("newSegment")}
            </Button>
          ) : undefined
        }
      />
      {!projectId && <ProjectPicker projects={projects} value={picked} onChange={setPicked} />}

      {sel && (
        <>
          <Dialog
            open={open}
            onClose={close}
            title={t("newSegment")}
            description={t("subtitle")}
            size="lg"
            footer={
              <>
                <Button variant="ghost" onClick={close}>{tc("cancel")}</Button>
                <Button onClick={create} disabled={saving || !name.trim()}>{t("create")}</Button>
              </>
            }
          >
            <SegmentFields idPrefix="new-segment" name={name} rules={rules} onName={setName} onRules={setRules} />
          </Dialog>

          <Card>
            <CardHeader><CardTitle>{t("listTitle", { count: segments.length })}</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {segments.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
              {segments.map((s) => (
                <Link
                  key={s.id}
                  href={`/projects/${sel}/segments/${s.id}`}
                  aria-label={`${s.name} — ${tc("detail")}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2 transition-colors hover:bg-surface-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="truncate text-sm font-semibold">{s.name}</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <div className="hidden flex-wrap justify-end gap-1 sm:flex">
                      {s.rules.map((r, i) => (
                        <Badge key={i} variant="neutral">{r.attribute}={r.value}</Badge>
                      ))}
                      {s.rules.length === 0 && <span className="text-xs text-muted-foreground">{t("noRules")}</span>}
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
