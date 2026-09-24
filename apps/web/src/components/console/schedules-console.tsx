"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Play, Pause, CalendarClock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input, Textarea, Select, Field } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";

type Kind = "daily" | "weekly" | "monthly";
type TargetType = "single" | "topic" | "broadcast";

type ScheduleMessage = { title?: string; body?: string; type: TargetType; target?: string };

type Schedule = {
  id: string;
  name: string;
  kind: Kind;
  weekday: number | null;
  dayOfMonth: number | null;
  hour: number;
  minute: number;
  message: ScheduleMessage;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
};

type Draft = {
  name: string;
  title: string;
  body: string;
  type: TargetType;
  target: string;
  kind: Kind;
  weekday: string;
  dayOfMonth: string;
  time: string;
};

type Errors = Partial<Record<"name" | "title" | "body" | "target" | "time", string>>;

const EMPTY: Draft = {
  name: "",
  title: "",
  body: "",
  type: "broadcast",
  target: "",
  kind: "daily",
  weekday: "1",
  dayOfMonth: "1",
  time: "09:00",
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" → 시·분. 브라우저 time 입력이 비었거나 초가 붙어 와도 흔들리지 않게 직접 읽는다. */
function parseTime(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

function toDraft(s: Schedule): Draft {
  return {
    name: s.name,
    title: s.message.title ?? "",
    body: s.message.body ?? "",
    type: s.message.type,
    target: s.message.target ?? "",
    kind: s.kind,
    weekday: String(s.weekday ?? 1),
    dayOfMonth: String(s.dayOfMonth ?? 1),
    time: `${pad(s.hour)}:${pad(s.minute)}`,
  };
}

/**
 * 반복 예약 화면.
 *
 * 발송 마법사(send-console)의 조각을 그대로 끌어오지 않았다: 그쪽은 단계·미리보기·
 * 변형·사용자 피커까지 한 덩어리의 상태를 공유해서, 반복 예약이 필요로 하는 네 칸
 * (제목·본문·대상·주기)만 떼어 오려면 그 상태를 통째로 흉내 내야 한다.
 * 여기서는 최소 폼을 따로 두고, 정교한 발송은 발송 화면에서 하도록 남겨 둔다.
 */
export function SchedulesConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("schedules");
  const tc = useTranslations("common");
  const locale = useLocale();
  const errorText = useAdminErrorText();

  const [schedules, setSchedules] = React.useState<Schedule[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<Schedule | null>(null);
  const [draft, setDraft] = React.useState<Draft>(EMPTY);
  const [errors, setErrors] = React.useState<Errors>({});
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const newBtnRef = React.useRef<HTMLButtonElement>(null);
  // 행이 사라지면 포커스가 body 로 떨어진다 — 키보드 사용자는 목록의 처음부터 다시 훑어야 한다
  const pendingFocus = React.useRef<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ schedules: Schedule[] }>(`/api/admin/projects/${projectId}/schedules`);
      setSchedules(d.schedules);
    } catch (e) {
      toast.error(errorText(e, tc("loadFailed")));
    } finally {
      setLoaded(true);
    }
  }, [projectId, errorText, tc]);

  React.useEffect(() => {
    load();
  }, [load]);

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    const el = target ? document.getElementById(target) : null;
    (el ?? newBtnRef.current)?.focus();
  }, [schedules]);

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
  }

  function startCreate() {
    setEditing(null);
    setDraft(EMPTY);
    setErrors({});
    setOpen(true);
  }

  function startEdit(s: Schedule) {
    setEditing(s);
    setDraft(toDraft(s));
    setErrors({});
    setOpen(true);
  }

  function close() {
    if (saving) return; // 저장 중에 닫으면 결과가 어디에도 안 보인다
    setOpen(false);
    setEditing(null);
    setErrors({});
    newBtnRef.current?.focus();
  }

  function validate(d: Draft): Errors {
    const next: Errors = {};
    if (!d.name.trim()) next.name = t("errName");
    if (!d.title.trim()) next.title = t("errTitle");
    if (!d.body.trim()) next.body = t("errBody");
    if (d.type !== "broadcast" && !d.target.trim()) next.target = t("errTarget");
    if (!parseTime(d.time)) next.time = t("errTime");
    return next;
  }

  async function save() {
    const found = validate(draft);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    const at = parseTime(draft.time)!;

    const body = {
      name: draft.name.trim(),
      kind: draft.kind,
      weekday: draft.kind === "weekly" ? Number(draft.weekday) : null,
      day_of_month: draft.kind === "monthly" ? Number(draft.dayOfMonth) : null,
      hour: at.hour,
      minute: at.minute,
      message: {
        title: draft.title.trim(),
        body: draft.body.trim(),
        type: draft.type,
        ...(draft.type === "broadcast" ? {} : { target: draft.target.trim() }),
      },
      enabled: editing ? editing.enabled : true,
    };

    setSaving(true);
    try {
      const path = editing
        ? `/api/admin/projects/${projectId}/schedules/${editing.id}`
        : `/api/admin/projects/${projectId}/schedules`;
      await adminApi(path, { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      toast.success(editing ? tc("saved") : t("created"));
      setOpen(false);
      setEditing(null);
      await load();
      newBtnRef.current?.focus();
    } catch (e) {
      toast.error(errorText(e, tc("saveFailed")));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(s: Schedule) {
    setBusyId(s.id);
    try {
      const d = await adminApi<{ schedule: Schedule }>(`/api/admin/projects/${projectId}/schedules/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      setSchedules((list) => list.map((x) => (x.id === s.id ? d.schedule : x)));
    } catch (e) {
      toast.error(errorText(e, tc("saveFailed")));
    } finally {
      setBusyId(null);
    }
  }

  async function remove(s: Schedule, index: number) {
    if (!confirm(tc("confirmRemove"))) return;
    // 지운 행의 이웃으로 포커스를 넘긴다(없으면 "새 예약" 버튼)
    const neighbor = schedules[index + 1] ?? schedules[index - 1];
    setBusyId(s.id);
    try {
      await adminApi(`/api/admin/projects/${projectId}/schedules/${s.id}`, { method: "DELETE" });
      pendingFocus.current = neighbor ? `schedule-${neighbor.id}-remove` : "";
      setSchedules((list) => list.filter((x) => x.id !== s.id));
      toast.success(tc("removed"));
    } catch (e) {
      toast.error(errorText(e, tc("removeFailed")));
    } finally {
      setBusyId(null);
    }
  }

  function recurrenceText(s: Schedule): string {
    const time = `${pad(s.hour)}:${pad(s.minute)}`;
    if (s.kind === "weekly") return t("recurWeekly", { weekday: t(`weekday${s.weekday ?? 0}` as "weekday0"), time });
    if (s.kind === "monthly") return t("recurMonthly", { day: s.dayOfMonth ?? 1, time });
    return t("recurDaily", { time });
  }

  return (
    <div className="w-full space-y-4">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        actions={
          <Button ref={newBtnRef} onClick={startCreate}>
            <Plus aria-hidden="true" className="h-4 w-4" /> {t("newSchedule")}
          </Button>
        }
      />

      <Dialog
        open={open}
        onClose={close}
        title={editing ? t("editSchedule") : t("newSchedule")}
        description={t("formHint")}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={close} disabled={saving}>
              {tc("cancel")}
            </Button>
            <Button onClick={save} disabled={saving}>
              {editing ? tc("save") : t("create")}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t("nameLabel")} error={errors.name}>
            <Input
              value={draft.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder={t("namePlaceholder")}
              disabled={saving}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("kindLabel")}>
              <Select value={draft.kind} onChange={(e) => patch({ kind: e.target.value as Kind })} disabled={saving}>
                <option value="daily">{t("kindDaily")}</option>
                <option value="weekly">{t("kindWeekly")}</option>
                <option value="monthly">{t("kindMonthly")}</option>
              </Select>
            </Field>
            <Field label={t("timeLabel")} hint={t("timeHint")} error={errors.time}>
              <Input type="time" value={draft.time} onChange={(e) => patch({ time: e.target.value })} disabled={saving} />
            </Field>
          </div>

          {draft.kind === "weekly" && (
            <Field label={t("weekdayLabel")}>
              <Select value={draft.weekday} onChange={(e) => patch({ weekday: e.target.value })} disabled={saving}>
                {[0, 1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {t(`weekday${n}` as "weekday0")}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          {draft.kind === "monthly" && (
            <Field label={t("dayOfMonthLabel")} hint={t("dayOfMonthHint")}>
              <Select value={draft.dayOfMonth} onChange={(e) => patch({ dayOfMonth: e.target.value })} disabled={saving}>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {t("dayOfMonthOption", { day: n })}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("targetTypeLabel")}>
              <Select
                value={draft.type}
                onChange={(e) => patch({ type: e.target.value as TargetType })}
                disabled={saving}
              >
                <option value="broadcast">{t("targetBroadcast")}</option>
                <option value="topic">{t("targetTopic")}</option>
                <option value="single">{t("targetSingle")}</option>
              </Select>
            </Field>
            {draft.type !== "broadcast" && (
              <Field
                label={draft.type === "topic" ? t("targetTopicLabel") : t("targetSingleLabel")}
                error={errors.target}
              >
                <Input
                  value={draft.target}
                  onChange={(e) => patch({ target: e.target.value })}
                  placeholder={draft.type === "topic" ? t("targetTopicPlaceholder") : t("targetSinglePlaceholder")}
                  disabled={saving}
                />
              </Field>
            )}
          </div>

          <Field label={t("titleLabel")} error={errors.title}>
            <Input
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder={t("titlePlaceholder")}
              disabled={saving}
            />
          </Field>
          <Field label={t("bodyLabel")} error={errors.body}>
            <Textarea
              value={draft.body}
              onChange={(e) => patch({ body: e.target.value })}
              placeholder={t("bodyPlaceholder")}
              rows={3}
              disabled={saving}
            />
          </Field>
        </div>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>{t("listTitle", { count: schedules.length })}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loaded && schedules.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}
          {schedules.map((s, i) => (
            <div
              key={s.id}
              className="flex flex-col gap-4 rounded-lg border border-border px-3.5 py-3 sm:flex-row sm:items-center"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold">{s.name}</span>
                  <Badge variant={s.enabled ? "primary" : "neutral"}>{s.enabled ? t("on") : t("off")}</Badge>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span>{recurrenceText(s)}</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    {s.enabled && s.nextRunAt
                      ? t("nextRun", { at: new Date(s.nextRunAt).toLocaleString(locale) })
                      : t("nextRunNone")}
                  </span>
                </p>
                <p className="truncate text-xs text-muted-foreground">{s.message.title}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:ms-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => toggle(s)}
                  disabled={busyId === s.id}
                  aria-label={`${s.name} — ${s.enabled ? t("disable") : t("enable")}`}
                >
                  {s.enabled ? (
                    <Pause aria-hidden="true" className="h-4 w-4" />
                  ) : (
                    <Play aria-hidden="true" className="h-4 w-4" />
                  )}
                  {s.enabled ? t("disable") : t("enable")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => startEdit(s)}
                  aria-label={`${s.name} — ${tc("edit")}`}
                >
                  <Pencil aria-hidden="true" className="h-4 w-4" />
                </Button>
                <Button
                  id={`schedule-${s.id}-remove`}
                  variant="ghost"
                  size="icon"
                  onClick={() => remove(s, i)}
                  disabled={busyId === s.id}
                  aria-label={`${s.name} — ${tc("remove")}`}
                >
                  <Trash2 aria-hidden="true" className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
