"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { BellOff, ChevronDown, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import { cn } from "@/lib/utils";

/** 서버 스키마와 같은 상한. lib/messages 를 직접 import 하면 drizzle·db 가 클라이언트 번들에 끌려온다. */
export const MAX_SEND_ACTIONS = 3;
export const TTL_SECONDS_MAX = 2_419_200;
export const BADGE_MAX = 99_999;
const SHORT_MAX = 64;
const DEEP_LINK_MAX = 2048;

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

type ErrorKey = "errOptBadge" | "errOptTtl" | "errOptActionId" | "errOptActionTitle" | "errOptActionDup" | "errOptActionLink";

export type SendOptionsErrors = { badge?: ErrorKey; ttl?: ErrorKey; actions: Record<string, ErrorKey> };

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
export function buildSendOptions(d: SendOptionsDraft): { options?: PushOptionsPayload; errors: SendOptionsErrors } {
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

  return { options: Object.keys(o).length > 0 ? o : undefined, errors };
}

export function hasSendOptionErrors(e: SendOptionsErrors): boolean {
  return Boolean(e.badge || e.ttl) || Object.keys(e.actions).length > 0;
}

/** 액션 오류가 세 칸 중 **어느 칸** 이야기인지. 아이디 칸에만 표시하면 엉뚱한 칸이 빨개진다 */
function actionErrorField(key: ErrorKey): "id" | "title" | "link" {
  if (key === "errOptActionTitle") return "title";
  if (key === "errOptActionLink") return "link";
  return "id"; // errOptActionId · errOptActionDup
}

/** 접힌 머리글에 "몇 개 켰는지" 를 보여 주려고 센다 — 접어 두면 설정한 걸 잊는다 */
export function countSendOptions(d: SendOptionsDraft): number {
  const filled = [d.sound, d.badge, d.collapseKey, d.androidChannelId, d.iosThreadId, d.ttlSeconds].filter((v) => v.trim()).length;
  const actions = d.actions.filter((a) => !actionBlank(a)).length;
  return filled + actions + (d.priority === "normal" ? 1 : 0) + (d.silent ? 1 : 0);
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
}: {
  value: SendOptionsDraft;
  onChange: (v: SendOptionsDraft) => void;
  errors: SendOptionsErrors;
  /** 발송이 옵션 오류로 막힐 때마다 올라가는 숫자 — 접어 둔 칸을 다시 펼쳐 무엇이 틀렸는지 보여 준다 */
  revealAt?: number;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const panelId = React.useId();
  const silentId = React.useId();
  const silentNoticeId = `${panelId}-silent-notice`;
  const [open, setOpen] = React.useState(false);

  const badgeError = errors.badge ? t(errors.badge, { max: BADGE_MAX }) : null;
  const ttlError = errors.ttl ? t(errors.ttl, { max: TTL_SECONDS_MAX }) : null;
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
  const errorSummary = [badgeError, ttlError, ...value.actions.map((a) => actionError(a.rowId))]
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
        className="flex h-9 w-full items-center gap-2 rounded-lg px-1 text-start text-xs font-semibold text-foreground transition-colors hover:bg-surface-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown aria-hidden="true" className={cn("h-4 w-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />
        <span>{t("optionsTitle")}</span>
        <span className="ms-auto truncate text-2xs font-medium text-muted-foreground">
          {count > 0 ? t("optionsCount", { count }) : t("optionsNone")}
        </span>
      </button>

      {/* 접혀 있어도 읽어 줘야 하므로 패널(hidden) 바깥에 둔다 */}
      <p role="status" aria-live="polite" className="sr-only">{liveError}</p>

      <div id={panelId} hidden={!open} className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("optionsHint")}</p>

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
              className="mt-0.5 h-4 w-4 shrink-0 rounded-sm border-border accent-primary disabled:opacity-50"
            />
            <span className="min-w-0">
              <span className="font-semibold">{t("optSilent")}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{t("optSilentHint")}</span>
            </span>
          </label>
          {/* 체크를 켜는 순간에도 들리도록 polite 영역 안에서 나타난다 */}
          <div role="status" aria-live="polite">
            {value.silent && (
              <p id={silentNoticeId} className="flex items-start gap-2 rounded-lg bg-surface-muted/60 p-2.5 text-xs text-muted-foreground">
                <BellOff aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{t("optSilentNotice")}</span>
              </p>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xs font-semibold text-foreground">{t("optActions")}</p>
          <p className="text-xs text-muted-foreground">{t("optActionsHint", { max: MAX_SEND_ACTIONS })}</p>

          {value.actions.map((a, i) => {
            const nameId = `${panelId}-${a.rowId}-name`;
            const err = errors.actions[a.rowId];
            const errText = actionError(a.rowId);
            // 오류는 틀린 칸 하나에만 — 아이디 칸에 몰아 두면 이름·딥링크가 틀려도 아이디가 빨개진다
            const field = err ? actionErrorField(err) : null;
            return (
              <div key={a.rowId} role="group" aria-labelledby={nameId} className="space-y-3 rounded-lg border border-border p-3">
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
                    <Trash2 aria-hidden="true" className="h-4 w-4" />
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
              <Plus aria-hidden="true" className="h-4 w-4" /> {t("optAddAction")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
