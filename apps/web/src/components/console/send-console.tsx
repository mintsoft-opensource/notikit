"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Send, Clock, FlaskConical, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Textarea, Field } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { PageHeader } from "@/components/layout/page-header";
import { useProjects, adminApi, useAdminErrorText } from "@/lib/admin-client";
import { SendTarget, type SendType } from "@/components/console/send-target";
import { SendPreview } from "@/components/console/send-preview";
import { SendVariables, useAttributeKeys } from "@/components/console/send-variables";
import { UserSearchDialog, type PickedUser } from "@/components/console/send-user-picker";
import { renderTemplate } from "@/lib/personalize";
import { buildCustomData, fieldKeyError, type TemplateField } from "@/lib/templates";
import { SendTemplatePicker, SendCustomFields, type ExtraField } from "@/components/console/send-custom-fields";
import type { MessageTemplate } from "@/components/console/template-form";
import { StepCard } from "@/components/console/send-step-card";
import { CountedLabel, SendImageField } from "@/components/console/send-content-fields";
import { SendSummary } from "@/components/console/send-summary";
import { SendReviewDialog } from "@/components/console/send-review-dialog";
import { useAudienceEstimate } from "@/components/console/send-estimate";
import { SendResultCard, type SendResult } from "@/components/console/send-result";
import { SendVariantFields, type VariantDraft } from "@/components/console/send-variants";
import {
  SendOptions,
  buildSendOptions,
  emptySendOptions,
  hasSendOptionErrors,
  type PushOptionsPayload,
  type SendOptionsDraft,
} from "@/components/console/send-options";
import {
  BODY_RECOMMENDED,
  TITLE_RECOMMENDED,
  collectWarnings,
  estimateRequest,
  imageUrlState,
} from "@/components/console/send-rules";

const TITLE_KEY = { single: "titleSingle", multi: "titleMulti", broadcast: "titleBroadcast", topic: "titleTopic" } as const;
const SUBTITLE_KEY = { single: "subtitleSingle", multi: "subtitleMulti", broadcast: "subtitleBroadcast", topic: "subtitleTopic" } as const;
const TARGET_ERROR_KEY = { single: "errTargetUser", multi: "errTargetUsers", topic: "errTargetTopic", broadcast: "errTargetUser" } as const;
const REVIEW_NAMES_SHOWN = 3;

type Content = {
  title: string;
  body: string;
  deep_link?: string;
  data?: Record<string, string>;
  image_url?: string;
  variants?: Array<{ title: string; body: string }>;
  options?: PushOptionsPayload;
  /** 받는 사람 현지 시각 "HH:MM" — options 안이 아니라 본문 최상위 필드다 */
  local_time?: string;
};

/**
 * 발송 콘솔 — 발송 방식(개별·전체·토픽)마다 화면이 따로 있다. 방식을 폼 안의 선택지로 두면
 * 전체 발송이 드롭다운 한 칸 차이로 나가 버린다. admin 세션으로 발송(api-secret 불필요).
 * 왼쪽은 ① 받는 사람 ② 내용 ③ 옵션 단계 카드, 오른쪽은 요약·미리보기 고정 열,
 * 실제 발송은 항상 검토 다이얼로그를 거친다.
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
  const uiLocale = useLocale();
  const errorText = useAdminErrorText();
  const { projects } = useProjects();
  const project = projects.find((p) => p.id === projectId);
  const appName = project?.name ?? "Notikit";
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
  const [variants, setVariants] = React.useState<VariantDraft[]>([]);
  const [deepLink, setDeepLink] = React.useState("");
  const [imageUrl, setImageUrl] = React.useState("");
  const [sendOptions, setSendOptions] = React.useState<SendOptionsDraft>(emptySendOptions);
  const builtOptions = React.useMemo(() => buildSendOptions(sendOptions), [sendOptions]);
  const optionsInvalid = hasSendOptionErrors(builtOptions.errors);
  const [optionsReveal, setOptionsReveal] = React.useState(0);
  /** 무음 푸시는 알림을 그리지 않으므로 제목·본문 없이도 성립한다 — 서버 finalizeMessage 와 같은 규칙 */
  const silent = sendOptions.silent;
  /**
   * 예약 발송은 날짜와 시각을 따로 받는다. DatePicker 는 `YYYY-MM-DD` 만 다루고,
   * 네이티브 datetime-local 은 브라우저마다 생김새가 달라 콘솔 톤과 어긋난다.
   */
  const [scheduleDate, setScheduleDate] = React.useState("");
  const [scheduleTime, setScheduleTime] = React.useState("09:00");
  const scheduleAt = scheduleDate ? `${scheduleDate}T${scheduleTime}` : "";
  const todayStr = React.useMemo(() => {
    const d = new Date();
    const p2 = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  }, []);
  const [sending, setSending] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const [reviewOpen, setReviewOpen] = React.useState(false);
  const [testPickerOpen, setTestPickerOpen] = React.useState(false);
  const [result, setResult] = React.useState<SendResult | null>(null);
  /** 발송 응답이 온 시점의 최신 제목·본문 — 응답을 기다리는 사이 바뀐 내용을 지우지 않으려고 본다 */
  const latestContentRef = React.useRef({ title, body });
  React.useEffect(() => {
    latestContentRef.current = { title, body };
  }, [title, body]);
  const scheduleDateId = React.useId();
  const scheduleTimeId = React.useId();
  const titleId = React.useId();
  const bodyId = React.useId();

  /**
   * 발송이 한 번이라도 막혔는가. 토스트는 몇 초 뒤 사라지므로, 그 뒤에도 **어느 칸이**
   * 잘못됐는지 알 수 있게 칸 옆 메시지와 aria-invalid 를 켜 둔다(WCAG 3.3.1).
   * 값이 채워지면 메시지는 저절로 사라진다 — 끄는 조작이 따로 필요 없다.
   */
  const [showErrors, setShowErrors] = React.useState(false);
  /** 막힌 이유를 한 번만 읽어 준다. 타이핑 중에 끼어들지 않도록 polite 한 곳에서만. */
  const [liveError, setLiveError] = React.useState("");
  const [focusTick, setFocusTick] = React.useState(0);
  const formRef = React.useRef<HTMLDivElement>(null);

  /**
   * 막힌 직후 **첫 번째** 잘못된 칸으로 포커스를 옮긴다. 옮기지 않으면 키보드·스크린리더
   * 사용자는 어디가 틀렸는지 알아도 그 칸까지 직접 훑어 가야 한다.
   * rAF 로 한 박자 미루는 이유: 알림 옵션 패널은 막힌 뒤에야 펼쳐지는데, 접혀 있는 동안엔
   * 그 안의 칸에 포커스가 들어가지 않는다.
   */
  React.useEffect(() => {
    if (focusTick === 0) return;
    const id = requestAnimationFrame(() => {
      const nodes = formRef.current?.querySelectorAll<HTMLElement>('[aria-invalid="true"]');
      for (const el of nodes ?? []) {
        if (el.offsetParent !== null) return el.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [focusTick]);

  const titleError = showErrors && !silent && !title.trim() ? t("errTitleRequired") : null;
  const bodyError = showErrors && !silent && !body.trim() ? t("errBodyRequired") : null;
  /** 칸 이름(라벨)은 그대로 두고 설명만 잇는다 — 글자 수 안내를 잃지 않게 이어 붙인다 */
  const describedBy = (id: string, error: string | null) => (error ? `${id}-count ${id}-error` : `${id}-count`);
  /** 변형은 여러 줄이라 "변형 어딘가가 비었다"로는 못 고친다 — 빈 칸마다 따로 붙인다 */
  const variantErrors = React.useMemo(() => {
    if (!showErrors) return {};
    const out: Record<string, { title?: string; body?: string }> = {};
    for (const v of variants) {
      const row = {
        ...(v.title.trim() ? {} : { title: t("errVariantTitleRequired") }),
        ...(v.body.trim() ? {} : { body: t("errVariantBodyRequired") }),
      };
      if (row.title || row.body) out[v.rowId] = row;
    }
    return out;
  }, [showErrors, variants, t]);

  const picksUsers = type === "single" || type === "multi";
  const hasTarget = picksUsers ? users.length > 0 : type === "broadcast" || Boolean(target);
  const isScheduled = scheduleAt.trim().length > 0;
  const busy = sending || testing;

  const estimateReq = React.useMemo(
    () => estimateRequest(type, target, users.map((u) => u.externalId)),
    [type, target, users]
  );
  const audience = useAudienceEstimate(projectId, estimateReq);

  /** 미리보기는 고른 첫 사용자 기준으로 치환한다. 토픽·전체는 누가 받을지 모르니 기본값으로 보여 준다. */
  const previewAs = picksUsers && users[0] ? users[0] : null;
  const previewCtx = { appName, now: new Date() };
  const previewRecipient = previewAs ?? {
    externalId: "",
    name: null,
    attributes: null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: uiLocale,
  };
  const renderedTitle = renderTemplate(title, previewRecipient, previewCtx);
  const renderedBody = renderTemplate(body, previewRecipient, previewCtx);
  const renderPreview = (tpl: string) => renderTemplate(tpl, previewRecipient, previewCtx);
  const renderedVariants =
    variants.length > 0
      ? [{ title: renderedTitle, body: renderedBody }, ...variants.map((v) => ({ title: renderPreview(v.title), body: renderPreview(v.body) }))]
      : undefined;
  const imageState = imageUrlState(imageUrl);
  const validImage = imageState === "valid" ? imageUrl.trim() : null;

  const warnings = collectWarnings({
    type,
    title: renderedTitle,
    body: renderedBody,
    imageUrl,
    devices: audience.shown?.devices ?? null,
    hasFirebase: project?.hasFirebase,
  });

  const df = React.useMemo(() => new Intl.DateTimeFormat(uiLocale, { dateStyle: "medium", timeStyle: "short" }), [uiLocale]);
  const scheduledDate = isScheduled ? new Date(scheduleAt) : null;
  const timeLabel = scheduledDate && !Number.isNaN(scheduledDate.getTime()) ? df.format(scheduledDate) : t("summaryNow");

  function insertVariable(token: string) {
    const field = lastFieldRef.current;
    const el = field === "title" ? titleRef.current : bodyRef.current;
    const current = field === "title" ? title : body;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    (field === "title" ? setTitle : setBody)(next);
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
    const overwrites = Boolean(title || body || deepLink) || Object.values(fieldValues).some((v) => v !== "");
    const needsConfirm = initial ? overwrites || extras.length > 0 : overwrites;
    if (needsConfirm && !confirm(t("confirmApplyTemplate", { name: tpl.name }))) return false;
    setTitle(tpl.title);
    setBody(tpl.body);
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
  const custom = collectData();

  /** 내용 검사 + 발송 본문. 테스트 발송과 실제 발송이 같은 내용을 보낸다. */
  function buildContent(): Content | null {
    // 토스트는 사라진다 — 막힌 이유를 칸 옆에 남기고(showErrors), 첫 잘못된 칸으로 포커스를 옮긴다
    const blocked = (message: string): null => {
      setShowErrors(true);
      setLiveError(message);
      setFocusTick((n) => n + 1);
      toast.error(message);
      return null;
    };
    if (!silent && (!title || !body)) return blocked(t("errTitleBody"));
    if (optionsInvalid) {
      // 옵션 칸을 접어 뒀을 수 있다 — 토스트만 띄우면 어디가 틀렸는지 찾을 방법이 없다
      setOptionsReveal((n) => n + 1);
      return blocked(t("errOptionsInvalid"));
    }
    if (custom.error) return blocked(custom.error);
    if (imageState === "notHttps" || imageState === "invalid") {
      return blocked(imageState === "notHttps" ? t("imageNotHttps") : t("imageInvalid"));
    }
    if (variants.some((v) => !v.title.trim() || !v.body.trim())) return blocked(t("errVariantEmpty"));
    setShowErrors(false);
    setLiveError("");
    const content: Content = { title, body };
    if (variants.length > 0) {
      content.variants = [{ title, body }, ...variants.map((v) => ({ title: v.title, body: v.body }))];
    }
    if (deepLink) content.deep_link = deepLink;
    if (custom.data) content.data = custom.data;
    if (validImage) content.image_url = validImage;
    if (builtOptions.options) content.options = builtOptions.options;
    if (builtOptions.localTime) content.local_time = builtOptions.localTime;
    return content;
  }

  /** datetime-local 은 타임존 없는 로컬 시각 — Date 로 통과시켜 오프셋 붙은 ISO 로 바꾼다 */
  function scheduledIso(): string | null | false {
    if (!isScheduled) return null;
    const d = new Date(scheduleAt);
    if (Number.isNaN(d.getTime()) || d.getTime() <= Date.now()) {
      toast.error(t("errSchedulePast"));
      return false;
    }
    return d.toISOString();
  }

  function openReview() {
    if (busy) return;
    if (!buildContent()) return;
    if (!hasTarget) return toast.error(t(TARGET_ERROR_KEY[type]));
    if (scheduledIso() === false) return;
    setReviewOpen(true);
  }

  async function send(processNow: boolean) {
    const content = buildContent();
    const scheduled = scheduledIso();
    if (!content || scheduled === false || sending) return;
    if (!hasTarget) {
      toast.error(t(TARGET_ERROR_KEY[type]));
      setReviewOpen(false);
      return;
    }

    setSending(true);
    setResult(null);
    const submitted = { title, body };

    let messageId: string | undefined;
    try {
      const payload: Record<string, unknown> = { ...content, type };
      if (type === "single") payload.target = users[0].externalId;
      else if (type === "multi") payload.targets = users.map((u) => u.externalId);
      else if (type === "topic") payload.target = target;
      if (scheduled) payload.scheduled_at = scheduled;

      const res = await adminApi<{ message?: { id?: string }; id?: string }>(
        `/api/admin/projects/${projectId}/messages`,
        { method: "POST", body: JSON.stringify(payload) }
      );
      messageId = res?.message?.id ?? res?.id;
    } catch (e) {
      const error = errorText(e, t("sendFailed"));
      toast.error(error);
      setResult({ status: "failed", error });
      setSending(false);
      setReviewOpen(false);
      return;
    }

    setReviewOpen(false);
    toast.success(scheduled ? t("resultScheduled") : t("queued"));
    const latest = latestContentRef.current;
    if (latest.title === submitted.title && latest.body === submitted.body) {
      setTitle("");
      setBody("");
      setVariants([]);
      setImageUrl("");
      setDeepLink("");
      setScheduleDate("");
      setScheduleTime("09:00");
      setFieldValues({});
      setExtras([]);
      setSendOptions(emptySendOptions());
    }

    // 예약 건은 지금 처리하지 않는다. 즉시 처리하면 예약 시각을 무시하고 나간다.
    if (!processNow || scheduled) {
      setResult({ status: scheduled ? "scheduled" : "queued", messageId, scheduledAt: scheduled });
      setSending(false);
      return;
    }

    // 큐잉은 이미 성공 — 즉시 처리 실패를 "발송 실패"로 오인시키지 않도록 별도 처리
    try {
      await adminApi(`/api/admin/projects/${projectId}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("processed"));
      setResult({ status: "processed", messageId });
    } catch (e) {
      const error = errorText(e, t("checkLogs"));
      toast.error(t("queuedProcessFailed", { error }));
      setResult({ status: "processFailed", messageId, error });
    }
    setSending(false);
  }

  function openTestPicker() {
    if (busy || !buildContent()) return;
    setTestPickerOpen(true);
  }

  /** 테스트 발송 — 고른 한 명에게만, 로그에는 테스트로 남는다. 작성 중인 내용은 지우지 않는다. */
  async function sendTest(user: PickedUser) {
    setTestPickerOpen(false);
    const content = buildContent();
    if (!content) return;
    setTesting(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/messages`, {
        method: "POST",
        body: JSON.stringify({ ...withoutVariants(content), type: "single", target: user.externalId, test: true }),
      });
    } catch (e) {
      toast.error(errorText(e, t("testSendFailed")));
      setTesting(false);
      return;
    }
    try {
      await adminApi(`/api/admin/projects/${projectId}/process-queue`, { method: "POST", body: "{}" });
      toast.success(t("testSent", { id: user.name || user.externalId }));
    } catch (e) {
      toast.error(t("queuedProcessFailed", { error: errorText(e, t("checkLogs")) }));
    }
    setTesting(false);
  }

  const targetLabel =
    type === "broadcast" ? t("reviewTargetBroadcast")
      : type === "topic" ? t("reviewTargetTopic", { name: target })
      : users.length <= REVIEW_NAMES_SHOWN ? users.map((u) => u.name || u.externalId).join(", ")
      : t("reviewTargetMore", {
          names: users.slice(0, REVIEW_NAMES_SHOWN).map((u) => u.name || u.externalId).join(", "),
          count: users.length - REVIEW_NAMES_SHOWN,
        });

  const variantsDone = variants.every((v) => v.title.trim() && v.body.trim());
  const contentDone =
    (silent || Boolean(title && body)) && variantsDone && !custom.error && imageState !== "notHttps" && imageState !== "invalid";
  const optionsDone = !optionsInvalid;
  const shown = audience.shown;

  return (
    <div className="flex w-full flex-1 flex-col gap-4">
      <PageHeader title={t(TITLE_KEY[type])} description={t(SUBTITLE_KEY[type])} />

      <div className="grid flex-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div ref={formRef} className="flex min-w-0 flex-col gap-4">
          {/* 막힌 이유를 한 번 읽어 준다. 눈으로 보는 메시지는 칸 옆에 계속 떠 있다. */}
          <p role="status" aria-live="polite" className="sr-only">{liveError}</p>

          <StepCard step={1} title={t("sectionTarget")} done={hasTarget}>
            <SendTarget projectId={projectId} type={type} target={target} onTarget={setTarget} users={users} onUsers={setUsers} />
          </StepCard>

          <StepCard step={2} title={t("sectionContent")} done={contentDone}>
            <SendTemplatePicker projectId={projectId} initialId={initialTemplateId} onApply={applyTemplate} />
            <div className="space-y-1">
              <CountedLabel htmlFor={titleId} label={t("titleLabel")} counterId={`${titleId}-count`} value={renderedTitle} max={TITLE_RECOMMENDED} />
              <Input
                id={titleId}
                ref={titleRef}
                aria-describedby={describedBy(titleId, titleError)}
                aria-invalid={titleError ? true : undefined}
                value={title}
                disabled={sending}
                onFocus={() => (lastFieldRef.current = "title")}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={255}
                placeholder={t("titlePlaceholder")}
              />
              {titleError && <p id={`${titleId}-error`} className="text-xs font-semibold text-error">{titleError}</p>}
            </div>
            <div className="space-y-1">
              <CountedLabel htmlFor={bodyId} label={t("bodyLabel")} counterId={`${bodyId}-count`} value={renderedBody} max={BODY_RECOMMENDED} />
              <Textarea
                id={bodyId}
                ref={bodyRef}
                aria-describedby={describedBy(bodyId, bodyError)}
                aria-invalid={bodyError ? true : undefined}
                className="min-h-32"
                value={body}
                disabled={sending}
                onFocus={() => (lastFieldRef.current = "body")}
                onChange={(e) => setBody(e.target.value)}
                maxLength={4000}
                placeholder={t("bodyPlaceholder")}
              />
              {bodyError && <p id={`${bodyId}-error`} className="text-xs font-semibold text-error">{bodyError}</p>}
            </div>
            <SendVariables
              keys={attributeKeys}
              onInsert={insertVariable}
              render={renderPreview}
              basis={previewAs ? previewAs.name || previewAs.externalId : null}
              disabled={sending}
            />
            <SendVariantFields variants={variants} onVariants={setVariants} render={renderPreview} errors={variantErrors} disabled={sending} />
            <SendImageField value={imageUrl} onChange={setImageUrl} disabled={sending} />
            <Field label={t("deepLink")} hint={t("helpDeepLink")}>
              <Input inputMode="url" spellCheck={false} autoComplete="off" value={deepLink} onChange={(e) => setDeepLink(e.target.value)} placeholder="myapp://path · https://…" />
            </Field>
          </StepCard>

          <StepCard step={3} title={t("sectionOptions")} done={hasTarget && contentDone && optionsDone}>
            {/* 날짜·시각 두 컨트롤을 한 묶음으로 읽히게 fieldset/legend 로 묶고, 각각에 라벨을 단다 */}
            <fieldset className="space-y-1">
              <legend className="text-xs font-semibold text-foreground">{t("scheduleLabel")}</legend>
              <div className="flex flex-wrap gap-2">
                <div className="flex min-w-48 flex-1 flex-col gap-1 sm:max-w-xs">
                  <label htmlFor={scheduleDateId} className="text-2xs text-muted-foreground">{t("scheduleDateLabel")}</label>
                  <DatePicker
                    id={scheduleDateId}
                    className="w-full"
                    value={scheduleDate}
                    onChange={setScheduleDate}
                    min={todayStr}
                    placeholder={t("scheduleDatePlaceholder")}
                    clearLabel={t("scheduleClear")}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor={scheduleTimeId} className="text-2xs text-muted-foreground">{t("scheduleTimeLabel")}</label>
                  <Input
                    id={scheduleTimeId}
                    type="time"
                    className="w-32"
                    value={scheduleTime}
                    onChange={(e) => setScheduleTime(e.target.value)}
                    disabled={!scheduleDate}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("scheduleHint")}</p>
            </fieldset>
            <SendOptions
              value={sendOptions}
              onChange={setSendOptions}
              errors={builtOptions.errors}
              revealAt={optionsReveal}
              disabled={sending}
            />
            <div className="space-y-2 border-t border-border pt-4">
              <p className="text-xs font-semibold text-foreground">{t("sectionCustomFields")}</p>
              <SendCustomFields fields={templateFields} values={fieldValues} onValues={setFieldValues} extras={extras} onExtras={setExtras} />
            </div>
          </StepCard>

          {result && <SendResultCard projectId={projectId} result={result} />}

          {/* 발송 바 — 작성 카드들 맨 아래. 화면에 고정하지 않는다(내용을 가려서 사용자가 원치 않음). */}
          <div>
            <Card className="flex flex-wrap items-center gap-3 px-3.5 py-2.5">
              <p className="flex min-w-0 items-center gap-2 text-sm" aria-live="polite">
                <Users aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-semibold tabular-nums">
                  {shown ? t("actionAudience", { users: shown.users, devices: shown.devices }) : t("actionAudienceUnknown")}
                </span>
              </p>
              <div className="ms-auto flex items-center gap-2">
                <Button variant="outline" onClick={openTestPicker} disabled={busy}>
                  <FlaskConical aria-hidden="true" /> {testing ? t("sending") : t("testSend")}
                </Button>
                <Button onClick={openReview} disabled={busy}>
                  {isScheduled ? <Clock aria-hidden="true" /> : <Send aria-hidden="true" />}
                  {isScheduled ? t("reviewSubmitScheduled") : t("reviewSubmit")}
                </Button>
              </div>
            </Card>
          </div>
        </div>

        <aside className="space-y-4">
          <SendSummary
            estimate={shown}
            loading={audience.loading}
            failed={audience.failed}
            hasRequest={audience.hasRequest}
            timeLabel={timeLabel}
            warnings={warnings}
          />
          <SendPreview
            appName={appName}
            title={renderedTitle}
            body={renderedBody}
            imageUrl={validImage}
            deepLink={deepLink}
            data={custom.data}
            variants={renderedVariants}
            silent={silent}
            actions={builtOptions.options?.actions}
            note={previewAs ? t("previewAs", { id: previewAs.name || previewAs.externalId }) : t("previewDefault")}
          />
        </aside>
      </div>

      <SendReviewDialog
        open={reviewOpen}
        onClose={() => setReviewOpen(false)}
        onConfirm={send}
        sending={sending}
        targetLabel={targetLabel}
        estimate={audience.fresh}
        isScheduled={isScheduled}
        timeLabel={timeLabel}
        title={renderedTitle}
        body={renderedBody}
        imageUrl={validImage}
        warnings={warnings}
        variants={renderedVariants}
        silent={silent}
        actions={builtOptions.options?.actions}
      />
      <UserSearchDialog
        open={testPickerOpen}
        projectId={projectId}
        multiple={false}
        initial={[]}
        title={t("testSendTitle")}
        description={t("testSendHint")}
        onClose={() => setTestPickerOpen(false)}
        onDone={(picked) => picked[0] && sendTest(picked[0])}
      />
    </div>
  );
}

/** 테스트 발송은 한 사람에게 가므로 변형 배정 없이 기본 내용(A)을 보낸다 */
function withoutVariants(content: Content): Omit<Content, "variants"> {
  const { variants: _variants, ...rest } = content;
  return rest;
}
