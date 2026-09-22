"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Send, Info, CheckCircle2, AlertTriangle, Clock } from "lucide-react";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Field } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { PageHeader } from "@/components/layout/page-header";
import { DataRow } from "@/components/ui/data-row";
import { useProjects, adminApi } from "@/lib/admin-client";
import { SendTarget, type SendType } from "@/components/console/send-target";
import { SendPreview } from "@/components/console/send-preview";
import { SendVariables, useAttributeKeys } from "@/components/console/send-variables";
import type { PickedUser } from "@/components/console/send-user-picker";
import { renderTemplate } from "@/lib/personalize";
import { buildCustomData, fieldKeyError, type TemplateField } from "@/lib/templates";
import { SendTemplatePicker, SendCustomFields, type ExtraField } from "@/components/console/send-custom-fields";
import type { MessageTemplate } from "@/components/console/template-form";

const TITLE_KEY = { single: "titleSingle", multi: "titleMulti", broadcast: "titleBroadcast", topic: "titleTopic" } as const;
const SUBTITLE_KEY = { single: "subtitleSingle", multi: "subtitleMulti", broadcast: "subtitleBroadcast", topic: "subtitleTopic" } as const;
const TARGET_ERROR_KEY = { single: "errTargetUser", multi: "errTargetUsers", topic: "errTargetTopic", broadcast: "errTargetUser" } as const;

/** 발송 뒤 하단에 남기는 결과 — 토스트는 사라지므로 확인할 수 있게 화면에 붙여둔다 */
type SendResult = {
  status: "queued" | "scheduled" | "processed" | "processFailed" | "failed";
  messageId?: string;
  scheduledAt?: string | null;
  error?: string;
};

/**
 * 발송 콘솔 — 발송 방식(개별·전체·토픽)마다 화면이 따로 있다. 방식을 폼 안의 선택지로 두면
 * 전체 발송이 드롭다운 한 칸 차이로 나가 버린다. admin 세션으로 발송(api-secret 불필요).
 */
export function SendConsole({
  projectId,
  type,
  initialTarget = "",
  initialTemplateId,
}: {
  projectId: string;
  type: SendType;
  initialTarget?: string;
  initialTemplateId?: string;
}) {
  const t = useTranslations("send");
  const { projects } = useProjects();
  const appName = projects.find((p) => p.id === projectId)?.name ?? "Notikit";
  const [target, setTarget] = React.useState(initialTarget);
  const [users, setUsers] = React.useState<PickedUser[]>([]);
  const [templateFields, setTemplateFields] = React.useState<TemplateField[]>([]);
  const [fieldValues, setFieldValues] = React.useState<Record<string, string>>({});
  const [extras, setExtras] = React.useState<ExtraField[]>([]);
  const attributeKeys = useAttributeKeys(projectId);
  /** 변수 버튼이 어느 칸에 넣을지 — 마지막으로 포커스한 제목/본문 */
  const titleRef = React.useRef<HTMLInputElement>(null);
  const bodyRef = React.useRef<HTMLTextAreaElement>(null);
  const lastFieldRef = React.useRef<"title" | "body">("body");
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [deepLink, setDeepLink] = React.useState("");
  const [processNow, setProcessNow] = React.useState(true);
  /**
   * 예약 발송은 날짜와 시각을 따로 받는다. DatePicker 는 `YYYY-MM-DD` 만 다루고,
   * 네이티브 datetime-local 은 브라우저마다 생김새가 달라 콘솔 톤과 어긋난다.
   * 아래 scheduleAt 은 둘을 합친 파생값이라 이후 로직은 그대로 쓴다.
   */
  const [scheduleDate, setScheduleDate] = React.useState("");
  const [scheduleTime, setScheduleTime] = React.useState("09:00");
  const scheduleAt = scheduleDate ? `${scheduleDate}T${scheduleTime}` : "";
  /** 과거 날짜는 고르지 못하게. 렌더마다 새로 만들되 날짜 단위라 변동이 없다. */
  const todayStr = React.useMemo(() => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }, []);
  const [sending, setSending] = React.useState(false);
  const [result, setResult] = React.useState<SendResult | null>(null);

  const picksUsers = type === "single" || type === "multi";
  const hasTarget = picksUsers ? users.length > 0 : type === "broadcast" || Boolean(target);
  // 예약이면 지금 큐를 돌릴 이유가 없다 — 예약 시각에 워커가 처리한다
  const isScheduled = scheduleAt.trim().length > 0;

  /** 미리보기는 고른 첫 사용자 기준으로 치환한다. 토픽·전체는 누가 받을지 모르니 기본값으로 보여 준다. */
  const previewAs = picksUsers && users[0] ? users[0] : null;

  function insertVariable(token: string) {
    const field = lastFieldRef.current;
    const el = field === "title" ? titleRef.current : bodyRef.current;
    const current = field === "title" ? title : body;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    (field === "title" ? setTitle : setBody)(next);
    // 넣은 뒤 커서를 변수 뒤로 — 이어서 타이핑할 수 있게
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  /** 템플릿 적용 — 이미 쓴 내용이 있으면 덮어쓰기 전에 묻는다. false 면 선택을 되돌린다. */
  function applyTemplate(tpl: MessageTemplate | null, { initial }: { initial: boolean }): boolean {
    if (!tpl) {
      setTemplateFields([]);
      setFieldValues({});
      return true;
    }
    const dirty = Boolean(title || body || deepLink);
    if (!initial && dirty && !confirm(t("confirmApplyTemplate", { name: tpl.name }))) return false;
    if (tpl.title) setTitle(tpl.title);
    if (tpl.body) setBody(tpl.body);
    setDeepLink(tpl.deepLink ?? "");
    setTemplateFields(tpl.fields);
    setFieldValues({});
    return true;
  }

  /** 커스텀 필드 → 푸시 data. 문제가 있으면 사용자에게 보일 메시지를 돌려준다. */
  function collectData(): { data?: Record<string, string>; error?: string } {
    const built = buildCustomData(templateFields, fieldValues);
    if ("missing" in built) return { error: t("errRequiredFields", { fields: built.missing.join(", ") }) };
    const data: Record<string, string> = { ...built.data };
    for (const x of extras) {
      const key = x.key.trim();
      if (!key && !x.value.trim()) continue;
      const err = fieldKeyError(key);
      if (err) return { error: t("errExtraKey", { key: key || "—" }) };
      if (key in data) return { error: t("errDuplicateKey", { key }) };
      if (x.value.trim()) data[key] = x.value.trim();
    }
    return Object.keys(data).length ? { data } : {};
  }
  const previewData = collectData().data;

  async function submit() {
    if (!title || !body) return toast.error(t("errTitleBody"));
    if (!hasTarget) return toast.error(t(TARGET_ERROR_KEY[type]));
    const custom = collectData();
    if (custom.error) return toast.error(custom.error);
    if (sending) return;
    if (type === "broadcast" && !confirm(t("confirmBroadcast"))) return;

    // datetime-local 은 타임존 없는 로컬 시각이라 그대로 보내면 서버가 UTC 로 읽는다.
    // Date 로 한 번 통과시켜 오프셋을 붙인 ISO 로 바꾼다.
    let scheduledIso: string | null = null;
    if (isScheduled) {
      const d = new Date(scheduleAt);
      if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) return toast.error(t("errSchedulePast"));
      scheduledIso = d.toISOString();
    }

    setSending(true);
    setResult(null);

    let messageId: string | undefined;
    try {
      const payload: Record<string, unknown> = { title, body, type };
      if (type === "single") payload.target = users[0].externalId;
      else if (type === "multi") payload.targets = users.map((u) => u.externalId);
      else if (type === "topic") payload.target = target;
      if (deepLink) payload.deep_link = deepLink;
      if (custom.data) payload.data = custom.data;
      if (scheduledIso) payload.scheduled_at = scheduledIso;

      const res = await adminApi<{ message?: { id?: string } }>(
        `/api/admin/projects/${projectId}/messages`,
        { method: "POST", body: JSON.stringify(payload) }
      );
      messageId = res?.message?.id;
    } catch (e) {
      const error = e instanceof Error ? e.message : t("sendFailed");
      toast.error(error);
      setResult({ status: "failed", error });
      setSending(false);
      return;
    }

    toast.success(isScheduled ? t("resultScheduled") : t("queued"));
    setTitle("");
    setBody("");

    // 예약 건은 지금 처리하지 않는다. 즉시 처리하면 예약 시각을 무시하고 나간다.
    if (!processNow || isScheduled) {
      setResult({ status: isScheduled ? "scheduled" : "queued", messageId, scheduledAt: scheduledIso });
      setSending(false);
      return;
    }

    // 큐잉은 이미 성공 — 즉시 처리 실패를 "발송 실패"로 오인시키지 않도록 별도 처리
    try {
      await adminApi(`/api/admin/projects/${projectId}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processed"));
      setResult({ status: "processed", messageId });
    } catch (e) {
      const error = e instanceof Error ? e.message : t("checkLogs");
      toast.error(t("queuedProcessFailed", { error }));
      setResult({ status: "processFailed", messageId, error });
    }
    setSending(false);
  }

  return (
    // 화면 높이를 채운다 — 남는 세로 공간을 본문 입력으로 돌린다
    <div className="flex w-full flex-1 flex-col space-y-4">
      <PageHeader title={t(TITLE_KEY[type])} description={t(SUBTITLE_KEY[type])} />

      {/* 작성은 넓게, 미리보기·안내는 오른쪽 좁은 열. 좁은 화면에서는 아래로 떨어진다. */}
      <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Card className="flex min-h-0 flex-col">
          <CardContent className="flex min-h-0 flex-1 flex-col divide-y divide-border">
            <Section title={t("sectionTarget")}>
              <SendTarget projectId={projectId} type={type} target={target} onTarget={setTarget} users={users} onUsers={setUsers} />
            </Section>

            <Section title={t("sectionContent")} className="flex min-h-0 flex-1 flex-col">
              <SendTemplatePicker projectId={projectId} initialId={initialTemplateId} onApply={applyTemplate} />
              <Field label={t("titleLabel")}>
                <Input ref={titleRef} value={title} onFocus={() => (lastFieldRef.current = "title")} onChange={(e) => setTitle(e.target.value)} maxLength={255} placeholder={t("titlePlaceholder")} />
              </Field>
              {/* 본문은 남는 세로를 가져간다 */}
              <Field label={t("bodyLabel")} className="flex min-h-0 flex-1 flex-col">
                <Textarea ref={bodyRef} className="min-h-28 flex-1" value={body} onFocus={() => (lastFieldRef.current = "body")} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder={t("bodyPlaceholder")} />
              </Field>
              <SendVariables keys={attributeKeys} onInsert={insertVariable} />
              <Field label={t("deepLink")}>
                <Input inputMode="url" spellCheck={false} autoComplete="off" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path · https://…" />
              </Field>
            </Section>

            <Section title={t("sectionCustomFields")}>
              <SendCustomFields fields={templateFields} values={fieldValues} onValues={setFieldValues} extras={extras} onExtras={setExtras} />
            </Section>

            <Section title={t("sectionOptions")}>
              <Field label={t("scheduleLabel")} hint={t("scheduleHint")}>
                <div className="flex gap-2 sm:max-w-md">
                  <DatePicker
                    className="flex-1"
                    value={scheduleDate}
                    onChange={setScheduleDate}
                    min={todayStr}
                    placeholder={t("scheduleDatePlaceholder")}
                    clearLabel={t("scheduleClear")}
                  />
                  {/* 날짜가 없으면 시각만 골라도 의미가 없다 */}
                  <Input
                    type="time"
                    aria-label={t("scheduleTimeLabel")}
                    className="w-32"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    disabled={!scheduleDate}
                  />
                </div>
              </Field>
              <label className="flex items-start gap-2 text-sm leading-relaxed">
                <input
                  type="checkbox"
                  checked={processNow && !isScheduled}
                  disabled={isScheduled}
                  onChange={(e) => setProcessNow(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
                />
                <span className={isScheduled ? "text-muted-foreground" : undefined}>
                  {isScheduled ? t("processNowDisabled") : t("processNow")}
                </span>
              </label>
            </Section>
          </CardContent>
          <CardFooter className="flex justify-end pt-3">
            <Button onClick={submit} disabled={sending}>
              {isScheduled ? <Clock aria-hidden="true" className="h-4 w-4" /> : <Send aria-hidden="true" className="h-4 w-4" />}
              {sending ? t("sending") : isScheduled ? t("submitScheduled") : t("submit")}
            </Button>
          </CardFooter>
        </Card>

        <aside className="space-y-4">
          <SendPreview
            appName={appName}
            title={renderTemplate(title, previewAs)}
            body={renderTemplate(body, previewAs)}
            deepLink={deepLink}
            data={previewData}
            note={previewAs ? t("previewAs", { id: previewAs.externalId }) : t("previewDefault")}
          />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Info aria-hidden="true" className="h-4 w-4 text-muted-foreground" /> {t("helpTitle")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                <li>{t("helpDeepLink")}</li>
                <li>{t("helpSuppression")}</li>
                <li>{t("helpLogOnly")}</li>
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              {result.status === "failed" || result.status === "processFailed" ? (
                <AlertTriangle aria-hidden="true" className={`h-4 w-4 ${result.status === "failed" ? "text-danger" : "text-warning"}`} />
              ) : result.status === "scheduled" ? (
                <Clock aria-hidden="true" className="h-4 w-4 text-primary" />
              ) : (
                <CheckCircle2 aria-hidden="true" className="h-4 w-4 text-success" />
              )}
              {t("resultTitle")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* 토스트는 사라지지만 메시지 ID 는 로그 대조에 필요하다 — 화면에 남긴다 */}
            <dl className="space-y-2 [&_dd]:min-w-0 [&_dd]:break-all">
              <DataRow
                label={t("resultStatus")}
                value={
                  result.status === "failed" ? t("resultFailed")
                    : result.status === "processFailed" ? t("resultProcessFailed")
                    : result.status === "processed" ? t("resultProcessed")
                    : result.status === "scheduled" ? t("resultScheduled")
                    : t("resultQueued")
                }
                tone={
                  result.status === "failed" ? "danger"
                    : result.status === "processFailed" ? "warning"
                    : "default"
                }
              />
              {result.messageId && <DataRow label={t("resultMessageId")} value={result.messageId} mono />}
              {result.scheduledAt && (
                <DataRow label={t("resultScheduledAt")} value={new Date(result.scheduledAt).toLocaleString()} />
              )}
              {result.error && <DataRow label={t("sendFailed")} value={result.error} />}
            </dl>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Section({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <section className={`space-y-3 py-4 first:pt-3 ${className ?? ""}`}>
      <h2 className="text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
