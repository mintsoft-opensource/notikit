"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Radio, Plus, Trash2, Send } from "lucide-react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { FIELD_HINT_TEXT, Field, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/layout/page-header";
import { Dialog } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { TopicRuleFields, emptyRules, cleanRules, isRuleDraftDirty, type Rule, type RuleDraft } from "./topic-rules-form";
import { FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";
import { useNumberFormat } from "@/lib/number-format";

type Topic = {
  id: string;
  name: string;
  rules: Rule[] | null;
  createdAt: string;
  deviceCount: number;
  userCount: number;
};

/**
 * 토픽 목록.
 *
 * 그룹은 명단을 채우는 방식이 둘이다 — 유저가 직접 구독하거나(구독식), 유저 속성
 * 조건으로 발송할 때마다 뽑거나(규칙식). 목록에서 배지로 구분한다.
 */
export function TopicsConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("audience");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();

  const [topics, setTopics] = React.useState<Topic[] | null>(null);
  const [name, setName] = React.useState("");
  const [mode, setMode] = React.useState<"subscribe" | "rules">("subscribe");
  const [rules, setRules] = React.useState<RuleDraft[]>(emptyRules);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ topics: Topic[] }>(`/api/admin/projects/${projectId}/audience/topics`);
      setTopics(d.topics);
    } catch (e) {
      setTopics([]);
      toast.error(errorText(e, tc("loadFailed")));
    }
  }, [projectId, tc]);

  const [open, setOpen] = React.useState(false);
  /**
   * 드래프트(이름·방식·조건)가 바뀔 때마다 올린다. 생성 응답을 기다리는 사이 무엇이든 고쳤다면
   * 완료 시 그 드래프트를 지우면 안 된다 — 이름만 비교하면 조건만 고친 경우를 놓친다.
   */
  const revisionRef = React.useRef(0);
  const editName = (v: string) => { revisionRef.current++; setName(v); };
  const editMode = (v: "subscribe" | "rules") => { revisionRef.current++; setMode(v); };
  const editRules = (v: RuleDraft[]) => { revisionRef.current++; setRules(v); };

  React.useEffect(() => { void load(); }, [load]);

  function reset() {
    revisionRef.current++;
    setName("");
    setMode("subscribe");
    setRules(emptyRules());
  }

  function closeDialog() {
    // 행동 조건(대상이 "유저 속성"이 아닌 줄)은 attribute·value 가 비어 있어도 입력한 것이다 —
    // 직접 비교하면 "전환 2회 이상" 같은 줄을 통째로 못 알아보고 묻지 않은 채 닫아 버린다.
    const dirty = name.trim() || rules.some(isRuleDraftDirty);
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    reset();
  }

  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim()) return;

    // 규칙식은 조건이 유효할 때만 보낸다. 구독식은 규칙 자체를 싣지 않는다.
    let payloadRules: Rule[] | undefined;
    if (mode === "rules") {
      const cleaned = cleanRules(
        rules,
        { partial: t("partialRule"), needRule: t("needRule") },
        (m) => toast.error(m)
      );
      if (!cleaned) return;
      payloadRules = cleaned;
    }

    // 제출 시점의 리비전을 기억한다 — 응답이 늦는 사이 드래프트를 고쳤다면 완료 시 지우지 않는다
    const submitted = revisionRef.current;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), ...(payloadRules ? { rules: payloadRules } : {}) }),
      });
      toast.success(t("topicCreated"));
      if (revisionRef.current === submitted) {
        reset();
        setOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(errorText(err, tc("loadFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function remove(topic: Topic) {
    // 구독식은 삭제하면 subscriptions 가 cascade 로 함께 사라진다 — 몇이나 끊기는지 보여 준 뒤 묻는다.
    // 규칙식은 끊길 구독이 없다. 같은 문구를 쓰면 없는 구독이 사라진다고 잘못 말하게 된다.
    const rule = Boolean(topic.rules?.length);
    const msg =
      topic.deviceCount > 0
        ? t(rule ? "confirmDeleteRuleTopic" : "confirmDeleteTopicWithSubs", {
            name: topic.name,
            count: nf.format(topic.deviceCount),
          })
        : tc("confirmRemove");
    if (!confirm(msg)) return;
    try {
      await adminApi(`/api/admin/projects/${projectId}/audience/topics/${topic.id}`, { method: "DELETE" });
      toast.success(t("topicDeleted"));
      await load();
    } catch (e) {
      toast.error(errorText(e, tc("loadFailed")));
    }
  }

  const nf = useNumberFormat();

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("topicsTitle")}
        description={t("topicsSubtitle")}
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus aria-hidden="true" className="size-4" /> {t("newTopic")}
          </Button>
        }
      />

      <Dialog
        open={open}
        onClose={closeDialog}
        title={t("newTopic")}
        description={t("newTopicHint")}
        footer={
          <>
            <Button variant="ghost" onClick={closeDialog}>{tc("cancel")}</Button>
            <Button onClick={() => create()} disabled={busy || !name.trim()}>
              {busy ? tc("loading") : t("createTopic")}
            </Button>
          </>
        }
      >
        <form onSubmit={create} className="space-y-4">
          <Field label={t("topicName")}>
            <Input id="new-topic-name" value={name} onChange={(e) => editName(e.target.value)} placeholder="news" maxLength={120} spellCheck={false} />
          </Field>

          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-semibold">{t("fillMode")}</legend>
            {(["subscribe", "rules"] as const).map((m) => (
              <label
                key={m}
                className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3.5 hover:bg-surface-muted/40 has-[:checked]:border-primary has-[:checked]:bg-accent-soft"
              >
                <input
                  type="radio"
                  name="fill-mode"
                  className="mt-1"
                  checked={mode === m}
                  onChange={() => editMode(m)}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{t(m === "subscribe" ? "fillSubscribe" : "fillRules")}</span>
                  <span className={cn("block", FIELD_HINT_TEXT)}>
                    {t(m === "subscribe" ? "fillSubscribeHint" : "fillRulesHint")}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>

          {mode === "rules" && <TopicRuleFields rules={rules} onRules={editRules} idPrefix="new-topic" />}

          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Dialog>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          {!topics && <div className="space-y-4 p-3.5"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>}
          {topics && topics.length === 0 && <EmptyState icon={Radio} title={t("noTopics")} />}
          {topics && topics.length > 0 && (
            <>
            <DataTable label={t("topicsTitle")} rowCount={topics.length + 1}>
            <TableHeader
              grid="sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto]"
              show="sm"
              columns={[
                { label: t("colTopic") },
                { label: t("colSubUsers") },
                { label: t("colSubDevices") },
                { label: "", blank: true },
              ]}
            />
            <TableBody>
              {topics.map((tp) => (
                <TableRow key={tp.id} className="grid gap-x-4 gap-y-1 px-3.5 py-2.5 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[minmax(0,1fr)_8rem_8rem_auto] sm:items-center">
                  <TableCell label={t("colTopic")} className="flex min-w-0 items-center gap-2">
                    <Link href={`/projects/${projectId}/topics/${tp.id}`} className={cn("truncate rounded-sm font-mono text-sm font-semibold hover:underline", FOCUS_RING)}>
                      {tp.name}
                    </Link>
                    <Badge variant={tp.rules?.length ? "warning" : "neutral"}>
                      {t(tp.rules?.length ? "kindRules" : "kindSubscribe")}
                    </Badge>
                  </TableCell>
                  <TableCell label={t("colSubUsers")} className="text-xs tabular-nums text-muted-foreground">
                    {t("subscriberUsers", { count: nf.format(tp.userCount) })}
                  </TableCell>
                  <TableCell label={t("colSubDevices")} className="text-xs tabular-nums text-muted-foreground">
                    {t("subscriberDevices", { count: nf.format(tp.deviceCount) })}
                  </TableCell>
                  <TableCell label={t("sendToTopic")} className="flex items-center gap-2 justify-self-end">
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/projects/${projectId}/send/topic?target=${encodeURIComponent(tp.name)}`}>
                        <Send aria-hidden="true" className="size-4" /> {t("sendToTopic")}
                      </Link>
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      aria-label={`${t("deleteTopic")} ${tp.name}`}
                      onClick={() => remove(tp)}
                    >
                      <Trash2 aria-hidden="true" className="size-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            </DataTable>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
