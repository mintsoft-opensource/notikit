"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { BellOff, ChevronDown, Clock, Gauge, Plus, Trash2, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Field, Input, Select } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { cn } from "@/lib/utils";
import { FOCUS_RING } from "@/components/ui/focus-ring";

/** 서버 스키마와 같은 상한. lib/messages 를 직접 import 하면 drizzle·db 가 클라이언트 번들에 끌려온다. */
export const MAX_SEND_ACTIONS = 3;
export const TTL_SECONDS_MAX = 2_419_200;
export const BADGE_MAX = 99_999;
const SHORT_MAX = 64;
const DEEP_LINK_MAX = 2048;
/** 서버(messages.ts local_time)와 **같은** 판정 — 어긋나면 화면은 통과시키고 서버가 422 로 막는다 */
const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 서버 local-delivery.ts 의 LOCAL_WINDOW_MS 와 같은 값. 안내 문구에만 쓴다. */
const LOCAL_WINDOW_HOURS = 24;
/** 서버 lib/holdout 과 **같은** 범위. 절반을 빼면 캠페인이 아니라 실험이다. */
export const HOLDOUT_MIN = 1;
export const HOLDOUT_MAX = 50;
/** 서버 messages.ts `max_sends_per_minute` 상한 */
export const MAX_PER_MINUTE = 1_000_000;

export type SendActionDraft = { rowId: string; id: string; title: string; deepLink: string };

/** 입력칸은 문자열로 들고 있는다 — 숫자로 바꿔 두면 "비움"과 0 을 구분할 수 없다 */
export type SendOptionsDraft = {
  sound: string;
  badge: string;
  collapseKey: string;
  androidChannelId: string;
  iosThreadId: string;
  ttlSeconds: string;
  priority: "normal" | "high";
  silent: boolean;
  /** 받는 사람 현지 시각 "HH:MM". 빈 문자열이면 쓰지 않는다(=즉시 발송). */
  localTime: string;
  /** 대조군 비율(%). 빈 문자열이면 쓰지 않는다. */
  holdoutPercent: string;
  /** 켜면 `quiet_hours:false` 로 나간다 — 프로젝트 방해금지 시간대를 이 발송만 건너뛴다 */
  ignoreQuietHours: boolean;
  /** 분당 발송 상한. 빈 문자열이면 프로젝트 설정을 따르고, "0" 은 이 발송만 제한 없음이다. */
  maxPerMinute: string;
  actions: SendActionDraft[];
};

export type PushActionPayload = { id: string; title: string; deep_link?: string };

export type PushOptionsPayload = {
  sound?: string;
  badge?: number;
  collapse_key?: string;
  android_channel_id?: string;
  ios_thread_id?: string;
  ttl_seconds?: number;
  priority?: "normal" | "high";
  silent?: boolean;
  actions?: PushActionPayload[];
};

type ErrorKey =
  | "errOptBadge"
  | "errOptTtl"
  | "errOptLocalTime"
  | "errOptHoldout"
  | "errOptHoldoutSingle"
  | "errOptMaxPerMinute"
  | "errOptActionId"
  | "errOptActionTitle"
  | "errOptActionDup"
  | "errOptActionLink";

export type SendOptionsErrors = {
  badge?: ErrorKey;
  ttl?: ErrorKey;
  localTime?: ErrorKey;
  holdout?: ErrorKey;
  maxPerMinute?: ErrorKey;
  actions: Record<string, ErrorKey>;
};

export function emptySendOptions(): SendOptionsDraft {
  return {
    sound: "",
    badge: "",
    collapseKey: "",
    androidChannelId: "",
    iosThreadId: "",
    ttlSeconds: "",
    priority: "high",
    silent: false,
    localTime: "",
    holdoutPercent: "",
    ignoreQuietHours: false,
    maxPerMinute: "",
    actions: [],
  };
}

export function newSendAction(): SendActionDraft {
  return { rowId: newRowId(), id: "", title: "", deepLink: "" };
}

/** 빈칸이면 null, 숫자가 아니면 "bad". 음수·소수는 애초에 정수가 아니므로 "bad" 로 떨어진다 */
function intOrNull(raw: string): number | null | "bad" {
  const s = raw.trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) return "bad";
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : "bad";
}

/** `myapp://path` 같은 커스텀 스킴도 허용한다 — 서버의 z.string().url() 과 같은 판정 */
function parsableUrl(raw: string): boolean {
  try {
    new URL(raw);
    return true;
  } catch {
    return false;
  }
}

function actionBlank(a: SendActionDraft): boolean {
  return !a.id.trim() && !a.title.trim() && !a.deepLink.trim();
}

/**
 * 초안 → 발송 본문의 `options`. 아무것도 고르지 않았으면 undefined 를 돌려준다 —
 * 빈 객체를 보내면 서버가 priority 기본값을 채워 모든 발송 로그에 옵션이 붙는다.
 */
export function buildSendOptions(
  d: SendOptionsDraft,
  /** 대조군을 쓸 수 있는 발송인가. `single` 은 한 명이라 "전부 빼거나 아무도 안 빼거나" 가 된다. */
  holdoutAllowed = true
): {
  options?: PushOptionsPayload;
  /**
   * 발송 본문의 `local_time` — `options` 안이 아니라 **본문 최상위** 필드다.
   * 서버가 기기 시간대로 묶어 회차를 나누므로 알림 표현(options)과 층이 다르다.
   */
  localTime?: string;
  /** 본문 최상위 `holdout_percent` */
  holdoutPercent?: number;
  /** 본문 최상위 `quiet_hours` — 덮을 때만(false) 싣는다 */
  quietHours?: false;
  /** 본문 최상위 `max_sends_per_minute`. 0 은 "이 발송은 제한 없음" 이라 빈칸과 다르다. */
  maxSendsPerMinute?: number;
  errors: SendOptionsErrors;
} {
  const errors: SendOptionsErrors = { actions: {} };
  const o: PushOptionsPayload = {};

  const put = (key: "sound" | "collapse_key" | "android_channel_id" | "ios_thread_id", raw: string) => {
    const v = raw.trim().slice(0, SHORT_MAX);
    if (v) o[key] = v;
  };
  put("sound", d.sound);
  put("collapse_key", d.collapseKey);
  put("android_channel_id", d.androidChannelId);
  put("ios_thread_id", d.iosThreadId);

  const badge = intOrNull(d.badge);
  if (badge === "bad" || (typeof badge === "number" && badge > BADGE_MAX)) errors.badge = "errOptBadge";
  else if (typeof badge === "number") o.badge = badge;

  const ttl = intOrNull(d.ttlSeconds);
  if (ttl === "bad" || (typeof ttl === "number" && ttl > TTL_SECONDS_MAX)) errors.ttl = "errOptTtl";
  else if (typeof ttl === "number") o.ttl_seconds = ttl;

  // priority 는 서버 기본값이 high — 보통일 때만 실어 보낸다
  if (d.priority === "normal") o.priority = "normal";
  if (d.silent) o.silent = true;

  // 빈칸은 "쓰지 않음"이다 — 형식이 틀린 것과 구분해야 한다(빈칸을 422 로 막으면 끌 수가 없다)
  const localTimeRaw = d.localTime.trim();
  let localTime: string | undefined;
  if (localTimeRaw && !LOCAL_TIME_RE.test(localTimeRaw)) errors.localTime = "errOptLocalTime";
  else if (localTimeRaw) localTime = localTimeRaw;

  /**
   * 대조군. 빈칸은 "쓰지 않음" 이고 범위 밖은 오류다 — 둘을 같이 묶으면 끌 수가 없다.
   * 단건 발송에서는 칸 자체를 숨기지만, 다른 방식으로 고른 뒤 방식을 바꾼 경우를 위해 여기서도 막는다.
   */
  const holdoutRaw = intOrNull(d.holdoutPercent);
  let holdoutPercent: number | undefined;
  if (holdoutRaw === "bad" || (typeof holdoutRaw === "number" && (holdoutRaw < HOLDOUT_MIN || holdoutRaw > HOLDOUT_MAX))) {
    errors.holdout = "errOptHoldout";
  } else if (typeof holdoutRaw === "number") {
    if (!holdoutAllowed) errors.holdout = "errOptHoldoutSingle";
    else holdoutPercent = holdoutRaw;
  }

  // 0 은 "이 발송만 제한 없음" 이다 — 빈칸(프로젝트 설정 따름)과 뜻이 다르므로 접어 넣지 않는다
  const perMinuteRaw = intOrNull(d.maxPerMinute);
  let maxSendsPerMinute: number | undefined;
  if (perMinuteRaw === "bad" || (typeof perMinuteRaw === "number" && perMinuteRaw > MAX_PER_MINUTE)) {
    errors.maxPerMinute = "errOptMaxPerMinute";
  } else if (typeof perMinuteRaw === "number") {
    maxSendsPerMinute = perMinuteRaw;
  }

  const actions: PushActionPayload[] = [];
  const seen = new Set<string>();
  for (const a of d.actions) {
    if (actionBlank(a)) continue;
    const id = a.id.trim();
    const title = a.title.trim();
    const link = a.deepLink.trim();
    if (!id || id.length > SHORT_MAX) {
      errors.actions[a.rowId] = "errOptActionId";
      continue;
    }
    if (seen.has(id)) {
      errors.actions[a.rowId] = "errOptActionDup";
      continue;
    }
    if (!title || title.length > SHORT_MAX) {
      errors.actions[a.rowId] = "errOptActionTitle";
      continue;
    }
    if (link && (link.length > DEEP_LINK_MAX || !parsableUrl(link))) {
      errors.actions[a.rowId] = "errOptActionLink";
      continue;
    }
    seen.add(id);
    actions.push(link ? { id, title, deep_link: link } : { id, title });
  }
  if (actions.length > 0) o.actions = actions.slice(0, MAX_SEND_ACTIONS);

  return {
    options: Object.keys(o).length > 0 ? o : undefined,
    localTime,
    holdoutPercent,
    // 켰을 때만 싣는다 — `true` 를 보내면 "프로젝트 설정을 따른다" 와 같은 뜻이라 잡음이다
    quietHours: d.ignoreQuietHours ? false : undefined,
    maxSendsPerMinute,
    errors,
  };
}

export function hasSendOptionErrors(e: SendOptionsErrors): boolean {
  return Boolean(e.badge || e.ttl || e.localTime || e.holdout || e.maxPerMinute) || Object.keys(e.actions).length > 0;
}

/** 액션 오류가 세 칸 중 **어느 칸** 이야기인지. 아이디 칸에만 표시하면 엉뚱한 칸이 빨개진다 */
function actionErrorField(key: ErrorKey): "id" | "title" | "link" {
  if (key === "errOptActionTitle") return "title";
  if (key === "errOptActionLink") return "link";
  return "id"; // errOptActionId · errOptActionDup
}

/** 접힌 머리글에 "몇 개 켰는지" 를 보여 주려고 센다 — 접어 두면 설정한 걸 잊는다 */
export function countSendOptions(d: SendOptionsDraft): number {
  const filled = [d.sound, d.badge, d.collapseKey, d.androidChannelId, d.iosThreadId, d.ttlSeconds, d.localTime, d.holdoutPercent, d.maxPerMinute].filter((v) => v.trim()).length;
  const actions = d.actions.filter((a) => !actionBlank(a)).length;
  return filled + actions + (d.priority === "normal" ? 1 : 0) + (d.silent ? 1 : 0) + (d.ignoreQuietHours ? 1 : 0);
}

/**
 * 알림 옵션 — 소리·배지·묶음키·TTL·우선순위·무음·액션 버튼.
 * 대부분의 발송은 기본값으로 나가므로 접어 둔다. 단계 카드 안에 있고 화면에 고정하지 않는다.
 */
export function SendOptions({
  value,
  onChange,
  errors,
  revealAt,
  disabled,
  holdoutAllowed = true,
}: {
  value: SendOptionsDraft;
  onChange: (v: SendOptionsDraft) => void;
  errors: SendOptionsErrors;
  /** 대조군 칸을 보일지. 단건 발송은 받는 사람이 한 명이라 대조군이 성립하지 않는다. */
  holdoutAllowed?: boolean;
  /** 발송이 옵션 오류로 막힐 때마다 올라가는 숫자 — 접어 둔 칸을 다시 펼쳐 무엇이 틀렸는지 보여 준다 */
  revealAt?: number;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const panelId = React.useId();
  const silentId = React.useId();
  const quietId = React.useId();
  const silentNoticeId = `${panelId}-silent-notice`;
  const quietNoticeId = `${panelId}-quiet-notice`;
  const [open, setOpen] = React.useState(false);

  const badgeError = errors.badge ? t(errors.badge, { max: BADGE_MAX }) : null;
  const ttlError = errors.ttl ? t(errors.ttl, { max: TTL_SECONDS_MAX }) : null;
  const localTimeError = errors.localTime ? t(errors.localTime) : null;
  const holdoutError = errors.holdout
    ? t(errors.holdout, { min: HOLDOUT_MIN, max: HOLDOUT_MAX })
    : null;
  const perMinuteError = errors.maxPerMinute ? t(errors.maxPerMinute, { max: MAX_PER_MINUTE }) : null;
  const actionError = (rowId: string) => {
    const key = errors.actions[rowId];
    return key ? t(key, { max: SHORT_MAX }) : null;
  };

  /**
   * 읽어 주는 건 여기 한 곳뿐이다. 오류 문단마다 role="alert" 를 달면 **글자를 칠 때마다**
   * 끼어들어(아이디→중복→이름→링크) 입력을 방해한다. 그래서 칸을 벗어날 때(blur)와
   * 발송이 막혔을 때만 polite 로 한 번 알린다. 눈으로 보는 오류는 칸 옆에 계속 떠 있다.
   */
  const [liveError, setLiveError] = React.useState("");
  const errorSummary = [badgeError, ttlError, localTimeError, holdoutError, perMinuteError, ...value.actions.map((a) => actionError(a.rowId))]
    .filter(Boolean)
    .join(" · ");
  const announce = (message: string | null) => setLiveError(message ?? "");

  // 접은 채로 발송을 누르면 어느 칸이 틀렸는지 볼 수 없다 — 발송이 막히면 펼치고 한 번 읽어 준다
  const revealedRef = React.useRef(0);
  React.useEffect(() => {
    if (!revealAt || revealedRef.current === revealAt) return;
    revealedRef.current = revealAt;
    setOpen(true);
    setLiveError(errorSummary);
  }, [revealAt, errorSummary]);

  const set = (patch: Partial<SendOptionsDraft>) => onChange({ ...value, ...patch });
  const setAction = (rowId: string, patch: Partial<SendActionDraft>) =>
    set({ actions: value.actions.map((a) => (a.rowId === rowId ? { ...a, ...patch } : a)) });
  const count = countSendOptions(value);

  /**
   * 액션을 더하면 3개째에서 "추가" 버튼이, 지우면 누르고 있던 삭제 버튼이 사라진다 —
   * 그대로 두면 포커스가 body 로 떨어져 키보드 사용자는 처음부터 다시 훑어야 한다.
   * topic-rules-form 과 같은 pendingFocus 방식: 다음 렌더에서 갈 곳으로 옮긴다.
   */
  const idInputRefs = React.useRef(new Map<string, HTMLInputElement>());
  const addActionRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocus = React.useRef<string | null>(null);
  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    (idInputRefs.current.get(target) ?? addActionRef.current)?.focus();
  }, [value.actions]);

  const addAction = () => {
    const next = newSendAction();
    pendingFocus.current = next.rowId; // 새 줄의 첫 칸으로 — "추가" 버튼은 3개째에 사라진다
    set({ actions: [...value.actions, next] });
  };
  const removeAction = (index: number) => {
    const rest = value.actions.filter((_, i) => i !== index);
    pendingFocus.current = rest[Math.max(0, index - 1)]?.rowId ?? ""; // 남은 줄이 없으면 "추가" 버튼
    set({ actions: rest });
  };

  return (
    <div className="space-y-4 border-t border-border pt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-lg px-1 text-start text-xs font-semibold text-foreground transition-colors hover:bg-surface-muted/60",
          FOCUS_RING
        )}
      >
        <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />
        <span>{t("optionsTitle")}</span>
        <span className="ms-auto truncate text-2xs font-medium text-muted-foreground">
          {count > 0 ? t("optionsCount", { count }) : t("optionsNone")}
        </span>
      </button>

      {/* 접혀 있어도 읽어 줘야 하므로 패널(hidden) 바깥에 둔다 */}
      <p role="status" aria-live="polite" className="sr-only">{liveError}</p>

      <div id={panelId} hidden={!open} className="space-y-4">
        <p className={FIELD_HINT_TEXT}>{t("optionsHint")}</p>

        {/* 7개 칸을 한 격자로 흘린다 — 칸 하나짜리 줄을 따로 두면 그 칸만 동떨어져 보인다 */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t("optPriority")} hint={t("optPriorityHint")}>
            <Select
              value={value.priority}
              disabled={disabled}
              onChange={(e) => set({ priority: e.target.value === "normal" ? "normal" : "high" })}
            >
              <option value="high">{t("optPriorityHigh")}</option>
              <option value="normal">{t("optPriorityNormal")}</option>
            </Select>
          </Field>

          <Field label={t("optSound")} hint={t("optSoundHint")}>
            <Input
              spellCheck={false}
              autoComplete="off"
              maxLength={SHORT_MAX}
              value={value.sound}
              disabled={disabled}
              onChange={(e) => set({ sound: e.target.value })}
              placeholder="default"
            />
          </Field>

          <Field label={t("optBadge")} hint={t("optBadgeHint")} error={badgeError}>
            <Input
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              value={value.badge}
              disabled={disabled}
              onChange={(e) => set({ badge: e.target.value })}
              onBlur={() => announce(badgeError)}
              placeholder="0"
            />
          </Field>

          <Field label={t("optTtl")} hint={t("optTtlHint")} error={ttlError}>
            <Input
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              value={value.ttlSeconds}
              disabled={disabled}
              onChange={(e) => set({ ttlSeconds: e.target.value })}
              onBlur={() => announce(ttlError)}
              placeholder="3600"
            />
          </Field>

          <Field label={t("optCollapseKey")} hint={t("optCollapseKeyHint")}>
            <Input
              spellCheck={false}
              autoComplete="off"
              maxLength={SHORT_MAX}
              value={value.collapseKey}
              disabled={disabled}
              onChange={(e) => set({ collapseKey: e.target.value })}
              placeholder="cart"
            />
          </Field>

          <Field label={t("optAndroidChannel")} hint={t("optAndroidChannelHint")}>
            <Input
              spellCheck={false}
              autoComplete="off"
              maxLength={SHORT_MAX}
              value={value.androidChannelId}
              disabled={disabled}
              onChange={(e) => set({ androidChannelId: e.target.value })}
              placeholder="promo"
            />
          </Field>

          {/* 마지막 칸은 남은 줄을 다 쓴다 — 3열 격자에서 혼자 1/3만 차지하고 끝나지 않게 */}
          <Field label={t("optIosThread")} hint={t("optIosThreadHint")} className="sm:col-span-2 lg:col-span-3">
            <Input
              spellCheck={false}
              autoComplete="off"
              maxLength={SHORT_MAX}
              value={value.iosThreadId}
              disabled={disabled}
              onChange={(e) => set({ iosThreadId: e.target.value })}
              placeholder="orders"
            />
          </Field>
        </div>

        {/*
          현지 시각 발송 — 격자 안에 끼우지 않는다. "무엇을 하는지"보다 "언제 나가는지"를
          바꾸는 설정이라, 설명 없이 칸 하나로 두면 예약 발송과 구분되지 않는다.
        */}
        <div className="space-y-2 rounded-lg border border-border p-3">
          <Field label={t("optLocalTime")} hint={t("optLocalTimeHint")} error={localTimeError}>
            <Input
              type="time"
              className="w-36"
              value={value.localTime}
              disabled={disabled}
              onChange={(e) => set({ localTime: e.target.value })}
              onBlur={() => announce(localTimeError)}
            />
          </Field>
          {/* 켜는 순간 들리도록 polite 영역 안에서 나타난다 — 무음 푸시 안내와 같은 방식 */}
          <div role="status" aria-live="polite">
            {value.localTime.trim() !== "" && (
              <p className={cn("flex items-start gap-2 rounded-lg bg-surface-muted/60 p-2.5", FIELD_HINT_TEXT)}>
                <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t("optLocalTimeNotice", { hours: LOCAL_WINDOW_HOURS })}</span>
              </p>
            )}
          </div>
        </div>

        {/*
          캠페인별 재정의 — 프로젝트 설정을 이 발송만 덮는 칸들이다. 알림 표현(소리·배지)과
          같은 격자에 섞으면 "이 발송만 다르게 나간다" 는 무게가 드러나지 않는다.
        */}
        <div className="space-y-4 rounded-lg border border-border p-3">
          <p className="text-xs font-semibold text-foreground">{t("optOverridesTitle")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("optMaxPerMinute")} hint={t("optMaxPerMinuteHint")} error={perMinuteError}>
              <Input
                inputMode="numeric"
                spellCheck={false}
                autoComplete="off"
                value={value.maxPerMinute}
                disabled={disabled}
                onChange={(e) => set({ maxPerMinute: e.target.value })}
                onBlur={() => announce(perMinuteError)}
                placeholder="600"
              />
            </Field>
            {holdoutAllowed && (
              <Field label={t("optHoldout")} hint={t("optHoldoutHint", { min: HOLDOUT_MIN, max: HOLDOUT_MAX })} error={holdoutError}>
                <Input
                  inputMode="numeric"
                  spellCheck={false}
                  autoComplete="off"
                  value={value.holdoutPercent}
                  disabled={disabled}
                  onChange={(e) => set({ holdoutPercent: e.target.value })}
                  onBlur={() => announce(holdoutError)}
                  placeholder="10"
                />
              </Field>
            )}
          </div>

          <label htmlFor={quietId} className="flex items-start gap-2 text-sm leading-relaxed">
            <input
              id={quietId}
              type="checkbox"
              checked={value.ignoreQuietHours}
              disabled={disabled}
              aria-describedby={value.ignoreQuietHours ? quietNoticeId : undefined}
              onChange={(e) => set({ ignoreQuietHours: e.target.checked })}
              className="mt-0.5 size-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="font-semibold">{t("optQuietHours")}</span>
              <span className={cn("mt-0.5 block", FIELD_HINT_TEXT)}>{t("optQuietHoursHint")}</span>
            </span>
          </label>
          {/* 켜는 순간 들리도록 polite 영역 안에서 나타난다 */}
          <div role="status" aria-live="polite">
            {value.ignoreQuietHours && (
              <p id={quietNoticeId} className={cn("flex items-start gap-2 rounded-lg bg-surface-muted/60 p-2.5", FIELD_HINT_TEXT)}>
                <Gauge aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t("optQuietHoursNotice")}</span>
              </p>
            )}
          </div>
          <div role="status" aria-live="polite">
            {holdoutAllowed && value.holdoutPercent.trim() !== "" && !holdoutError && (
              <p className={cn("flex items-start gap-2 rounded-lg bg-surface-muted/60 p-2.5", FIELD_HINT_TEXT)}>
                <Users aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t("optHoldoutNotice", { percent: value.holdoutPercent.trim() })}</span>
              </p>
            )}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          <label htmlFor={silentId} className="flex items-start gap-2 text-sm leading-relaxed">
            <input
              id={silentId}
              type="checkbox"
              checked={value.silent}
              disabled={disabled}
              // 켰을 때 나타나는 안내를 체크박스에 이어 준다 — 안 이으면 스크린리더는
              // "무음 푸시는 제목·본문이 표시되지 않는다"는 사실을 끝내 듣지 못한다
              aria-describedby={value.silent ? silentNoticeId : undefined}
              onChange={(e) => set({ silent: e.target.checked })}
              className="mt-0.5 size-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="font-semibold">{t("optSilent")}</span>
              <span className={cn("mt-0.5 block", FIELD_HINT_TEXT)}>{t("optSilentHint")}</span>
            </span>
          </label>
          {/* 체크를 켜는 순간에도 들리도록 polite 영역 안에서 나타난다 */}
          <div role="status" aria-live="polite">
            {value.silent && (
              <p id={silentNoticeId} className={cn("flex items-start gap-2 rounded-lg bg-surface-muted/60 p-2.5", FIELD_HINT_TEXT)}>
                <BellOff aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                <span>{t("optSilentNotice")}</span>
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <p className="text-xs font-semibold text-foreground">{t("optActions")}</p>
          <p className={FIELD_HINT_TEXT}>{t("optActionsHint", { max: MAX_SEND_ACTIONS })}</p>

          {value.actions.map((a, i) => {
            const nameId = `${panelId}-${a.rowId}-name`;
            const err = errors.actions[a.rowId];
            const errText = actionError(a.rowId);
            // 오류는 틀린 칸 하나에만 — 아이디 칸에 몰아 두면 이름·딥링크가 틀려도 아이디가 빨개진다
            const field = err ? actionErrorField(err) : null;
            return (
              <div key={a.rowId} role="group" aria-labelledby={nameId} className="space-y-4 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p id={nameId} className="text-xs font-semibold text-foreground">{t("optActionLegend", { index: i + 1 })}</p>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={a.title.trim() ? t("optRemoveActionNamed", { title: a.title.trim() }) : t("optRemoveAction", { index: i + 1 })}
                    disabled={disabled}
                    onClick={() => removeAction(i)}
                  >
                    <Trash2 aria-hidden="true" className="size-4" />
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label={t("optActionId")} hint={t("optActionIdHint")} error={field === "id" ? errText : null}>
                    <Input
                      ref={(el) => {
                        if (el) idInputRefs.current.set(a.rowId, el);
                        else idInputRefs.current.delete(a.rowId);
                      }}
                      className="font-mono"
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={SHORT_MAX}
                      value={a.id}
                      disabled={disabled}
                      onChange={(e) => setAction(a.rowId, { id: e.target.value })}
                      onBlur={() => announce(errText)}
                      placeholder="buy"
                    />
                  </Field>
                  <Field label={t("optActionTitle")} error={field === "title" ? errText : null}>
                    <Input
                      spellCheck={false}
                      autoComplete="off"
                      maxLength={SHORT_MAX}
                      value={a.title}
                      disabled={disabled}
                      onChange={(e) => setAction(a.rowId, { title: e.target.value })}
                      onBlur={() => announce(errText)}
                      placeholder={t("optActionTitlePlaceholder")}
                    />
                  </Field>
                </div>
                <Field label={t("optActionLink")} hint={t("optActionLinkHint")} error={field === "link" ? errText : null}>
                  <Input
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={DEEP_LINK_MAX}
                    value={a.deepLink}
                    disabled={disabled}
                    onChange={(e) => setAction(a.rowId, { deepLink: e.target.value })}
                    onBlur={() => announce(errText)}
                    placeholder="myapp://cart · https://…"
                  />
                </Field>
              </div>
            );
          })}

          {value.actions.length < MAX_SEND_ACTIONS && (
            <Button ref={addActionRef} type="button" variant="outline" disabled={disabled} onClick={addAction}>
              <Plus aria-hidden="true" className="size-4" /> {t("optAddAction")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
