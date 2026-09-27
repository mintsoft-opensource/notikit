"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations, useLocale } from "next-intl";
import { toast } from "sonner";
import { ArrowLeft, Trash2, Send, AlertTriangle, RotateCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { DataRow } from "@/components/ui/data-row";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { MAX_BEHAVIOR_COUNT, MAX_BEHAVIOR_DAYS } from "@/lib/topic-rule-ops";
import { TopicRuleFields, cleanRules, toRuleDrafts, type Rule, type RuleDraft } from "./topic-rules-form";
import { useNumberFormat } from "@/lib/number-format";

type Topic = { id: string; name: string; rules: Rule[] | null; createdAt: string };

export function TopicDetail({ projectId, topicId }: { projectId: string; topicId: string }) {
  const t = useTranslations("audience");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const nf = useNumberFormat();

  type Detail = { topic: Topic; deviceCount: number; userCount: number };
  const [data, setData] = React.useState<Detail | null>(null);
  const [missing, setMissing] = React.useState(false);
  /** 404 가 아닌 실패 — 스켈레톤을 영원히 돌리지 않고 오류와 재시도를 보인다 */
  const [failed, setFailed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  /** state 는 다음 렌더에야 바뀐다 — 같은 틱의 연속 클릭을 막으려면 ref 로 본다 */
  const busyRef = React.useRef(false);
  const [rules, setRules] = React.useState<RuleDraft[] | null>(null);
  const reqRef = React.useRef(0);

  const load = React.useCallback(async () => {
    const my = ++reqRef.current;
    setFailed(false);
    try {
      const d = await adminApi<Detail>(`/api/admin/projects/${projectId}/audience/topics/${topicId}`);
      if (my !== reqRef.current) return;
      setData(d);
      setRules(d.topic.rules ? toRuleDrafts(d.topic.rules) : null);
    } catch (e) {
      if (my !== reqRef.current) return;
      // 404 는 "없음"으로, 나머지는 오류로 구분한다 — 지워진 것과 장애는 대응이 다르다
      if (e instanceof Error && /not found/i.test(e.message)) setMissing(true);
      else setFailed(true);
    }
  }, [projectId, topicId]);

  React.useEffect(() => {
    load();
    // 언마운트·대상 변경 후 도착한 응답은 버린다
    return () => { reqRef.current++; };
  }, [load]);

  function begin(): boolean {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    return true;
  }

  function end() {
    busyRef.current = false;
    setBusy(false);
  }

  async function saveRules() {
    if (!rules || busyRef.current) return;
    const cleaned = cleanRules(
      rules,
      {
        partial: t("partialRule"),
        needRule: t("needRule"),
        needNumber: t("ruleNeedNumber"),
        needDays: t("ruleNeedDays", { max: MAX_BEHAVIOR_DAYS }),
        needCount: t("ruleNeedCount", { max: MAX_BEHAVIOR_COUNT }),
      },
      (m) => toast.error(m)
    );
    if (!cleaned) return;
    if (!begin()) return;
    try {
      const d = await adminApi<{ topic: Topic }>(
        `/api/admin/projects/${projectId}/audience/topics/${topicId}`,
        { method: "PATCH", body: JSON.stringify({ rules: cleaned }) }
      );
      toast.success(t("rulesSaved"));
      // 규칙이 바뀌면 대상 수도 바뀐다 — 화면의 수가 옛 규칙 기준으로 남지 않게 다시 읽는다
      const fresh = await adminApi<Detail>(`/api/admin/projects/${projectId}/audience/topics/${topicId}`);
      setData(fresh);
      setRules(d.topic.rules ? toRuleDrafts(d.topic.rules) : null);
    } catch (e) {
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      end();
    }
  }

  async function remove() {
    if (!data || busyRef.current) return;
    // 구독식은 몇 명이 끊기는지, 규칙식은 지금 몇 명이 대상인지 보여 준 뒤 묻는다
    const rule = Boolean(data.topic.rules?.length);
    const msg =
      data.deviceCount > 0
        ? t(rule ? "confirmDeleteRuleTopic" : "confirmDeleteTopicWithSubs", {
            name: data.topic.name,
            count: nf.format(data.deviceCount),
          })
        : tc("confirmRemove");
    if (!confirm(msg)) return;
    if (!begin()) return;
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics/${topicId}`, { method: "DELETE" });
      toast.success(tc("removed"));
      router.push(`/projects/${projectId}/topics`);
    } catch (e) {
      toast.error(errorText(e, tc("removeFailed")));
      end();
    }
  }

  const backHref = `/projects/${projectId}/topics`;

  if (missing) {
    return (
      <div className="w-full space-y-4">
        <PageHeader title={tc("notFound")} />
        <Button asChild variant="outline">
          <Link href={backHref}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
        </Button>
      </div>
    );
  }

  if (failed && !data) {
    return (
      <div className="w-full space-y-4">
        <EmptyState
          icon={AlertTriangle}
          title={tc("loadFailed")}
          action={
            <Button variant="outline" onClick={load}>
              <RotateCw aria-hidden="true" className="size-4" /> {tc("retry")}
            </Button>
          }
        />
      </div>
    );
  }

  if (!data) {
    return <div className="w-full space-y-4"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full" /></div>;
  }

  const ruleFilled = Boolean(data.topic.rules?.length);

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {data.topic.name}
            <Badge variant={ruleFilled ? "warning" : "neutral"}>
              {t(ruleFilled ? "kindRules" : "kindSubscribe")}
            </Badge>
          </span>
        }
        description={t(ruleFilled ? "fillRulesHint" : "fillSubscribeHint")}
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href={backHref}><ArrowLeft aria-hidden="true" className="size-4" /> {tc("back")}</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href={`/projects/${projectId}/send/topic?target=${encodeURIComponent(data.topic.name)}`}>
                <Send aria-hidden="true" className="size-4" /> {t("sendToTopic")}
              </Link>
            </Button>
            <Button variant="destructive" onClick={remove} disabled={busy}>
              <Trash2 aria-hidden="true" className="size-4" /> {tc("remove")}
            </Button>
          </>
        }
      />

      <Card>
        <CardContent className="pt-3.5">
          {/* DataRow 는 dt/dd 를 낸다 — dl 로 감싸지 않으면 정의목록 의미가 사라진다 */}
          <dl className="space-y-1">
          <DataRow label={t(ruleFilled ? "colMatchedUsers" : "colSubUsers")} value={nf.format(data.userCount)} />
          <DataRow label={t(ruleFilled ? "colMatchedDevices" : "colSubDevices")} value={nf.format(data.deviceCount)} />
          <DataRow label="ID" value={data.topic.id} />
          <DataRow label={tc("createdAt")} value={new Date(data.topic.createdAt).toLocaleString()} />
          </dl>
        </CardContent>
      </Card>

      {ruleFilled && rules && (
        <Card>
          <CardContent className="space-y-4 pt-3.5">
            <TopicRuleFields rules={rules} onRules={setRules} idPrefix="topic-rules" disabled={busy} />
            <div className="flex justify-end">
              <Button onClick={saveRules} disabled={busy}>{busy ? tc("loading") : tc("save")}</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
