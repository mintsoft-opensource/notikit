"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { PageHeader } from "@/components/layout/page-header";
import { SegmentFields, EMPTY_RULES, cleanRules, type Rule } from "@/components/console/segment-form";
import { adminApi } from "@/lib/admin-client";

type Segment = { id: string; name: string; rules: Rule[]; createdAt: string };

export function SegmentDetail({ projectId, segmentId }: { projectId: string; segmentId: string }) {
  const t = useTranslations("segments");
  const tc = useTranslations("common");
  const router = useRouter();

  const [loaded, setLoaded] = React.useState<Segment | null>(null);
  const [missing, setMissing] = React.useState(false);
  const [name, setName] = React.useState("");
  const [rules, setRules] = React.useState<Rule[]>(EMPTY_RULES);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let stale = false;
    (async () => {
      try {
        const d = await adminApi<{ segment: Segment }>(`/api/admin/projects/${projectId}/segments/${segmentId}`);
        if (stale) return;
        setLoaded(d.segment);
        setName(d.segment.name);
        setRules(d.segment.rules.length ? d.segment.rules : EMPTY_RULES);
      } catch (e) {
        if (stale) return;
        // 404 는 "없음"으로, 나머지는 오류로 구분한다 — 지워진 것과 장애는 대응이 다르다
        if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
        else toast.error(e instanceof Error ? e.message : tc("loadFailed"));
      }
    })();
    return () => { stale = true; };
  }, [projectId, segmentId, tc]);

  const dirty =
    !!loaded &&
    (name !== loaded.name ||
      JSON.stringify(rules.filter((r) => r.attribute || r.value)) !== JSON.stringify(loaded.rules));

  async function save() {
    if (!name.trim() || saving) return;
    const cleaned = cleanRules(rules, { partial: t("partialRule"), confirmNoRules: t("confirmNoRules") }, toast.error);
    if (!cleaned) return;

    setSaving(true);
    try {
      const d = await adminApi<{ segment: Segment }>(`/api/admin/projects/${projectId}/segments/${segmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ name: name.trim(), rules: cleaned }),
      });
      setLoaded(d.segment);
      setRules(d.segment.rules.length ? d.segment.rules : EMPTY_RULES);
      toast.success(tc("saved"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(tc("confirmRemove"))) return;
    setSaving(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/segments/${segmentId}`, { method: "DELETE" });
      toast.success(tc("removed"));
      router.push(`/projects/${projectId}/segments`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : tc("removeFailed"));
      setSaving(false);
    }
  }

  const backHref = `/projects/${projectId}/segments`;

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
        <Skeleton className="h-48 w-full" />
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

      <Card>
        <CardHeader><CardTitle>{tc("edit")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <SegmentFields idPrefix="segment" name={name} rules={rules} onName={setName} onRules={setRules} />
          <div className="flex justify-end">
            {/* 바뀐 게 없으면 비활성 — 누르면 저장된 것처럼 보이지만 아무 일도 안 일어난다 */}
            <Button onClick={save} disabled={saving || !dirty || !name.trim()}>{tc("save")}</Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-3.5">
          {/* DataRow 는 dt/dd 를 낸다 — dl 로 감싸지 않으면 정의목록 의미가 사라진다 */}
          <dl className="space-y-1">
          <DataRow label="ID" value={loaded.id} />
          <DataRow label={tc("createdAt")} value={new Date(loaded.createdAt).toLocaleString()} />
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}
