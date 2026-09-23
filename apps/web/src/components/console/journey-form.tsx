"use client";

import { useTranslations } from "next-intl";
import { X, Send, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Field } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";

export type Step = { type: "send" | "wait"; title?: string; body?: string; hours?: number };

export const EMPTY_STEPS: Step[] = [{ type: "send", title: "", body: "" }];

/**
 * 편집 중인 스텝. 대기 시간은 문자열로 둔다 — 숫자로 들고 있으면 칸을 비우는 순간 0 이 되어
 * 지우고 다시 쓰는 흐름이 막힌다. 숫자 변환은 저장할 때(cleanSteps) 한 번만 한다.
 */
export type StepDraft = { rowId: string; type: Step["type"]; title: string; body: string; hours: string };

const DEFAULT_WAIT_HOURS = "24";

export function toStepDrafts(steps: Step[]): StepDraft[] {
  const source = steps.length ? steps : EMPTY_STEPS;
  return source.map((s) => ({
    rowId: newRowId(),
    type: s.type,
    title: s.title ?? "",
    body: s.body ?? "",
    hours: s.hours === undefined ? "" : String(s.hours),
  }));
}

/** 드래프트끼리 저장될 내용이 같은지 — rowId 는 화면용이라 비교에서 뺀다 */
export function sameSteps(a: StepDraft[], b: StepDraft[]): boolean {
  return JSON.stringify(cleanSteps(a)) === JSON.stringify(cleanSteps(b));
}

/**
 * 저니 입력 필드 — 생성 모달과 수정 화면이 **같은 컴포넌트**를 쓴다.
 * 따로 두면 한쪽에만 규칙이 추가되어 "생성은 되는데 수정하면 검증이 다른" 상태가 된다.
 */
export function JourneyFields({
  name,
  steps,
  onName,
  onSteps,
  idPrefix,
  nameLocked = false,
  disabled = false,
}: {
  name: string;
  steps: StepDraft[];
  onName: (v: string) => void;
  onSteps: (v: StepDraft[]) => void;
  idPrefix: string;
  /** 수정 화면에서는 이름을 잠근다 — SDK enroll 이 이름으로 저니를 찾는다 */
  nameLocked?: boolean;
  /** 저장 중에는 편집을 막는다 — 저장이 끝나며 서버 값으로 되맞출 때 그사이 고친 내용이 사라진다 */
  disabled?: boolean;
}) {
  const t = useTranslations("journeys");

  function updateStep(rowId: string, patch: Partial<StepDraft>) {
    onSteps(steps.map((s) => (s.rowId === rowId ? { ...s, ...patch } : s)));
  }

  function addStep(type: Step["type"]) {
    const hours = type === "wait" ? DEFAULT_WAIT_HOURS : "";
    onSteps([...steps, { rowId: newRowId(), type, title: "", body: "", hours }]);
  }

  return (
    <div className="space-y-3">
      <Field label={t("nameLabel")} hint={nameLocked ? t("nameLockedHint") : undefined}>
        <Input
          id={`${idPrefix}-name`}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder={t("namePlaceholder")}
          readOnly={nameLocked}
          disabled={nameLocked || disabled}
        />
      </Field>
      <div className="space-y-2">
        <Label>{t("stepsLabel")}</Label>
        {steps.map((s, i) => (
          <div key={s.rowId} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Select
                aria-label={t("stepType")}
                value={s.type}
                onChange={(e) => updateStep(s.rowId, { type: e.target.value as Step["type"] })}
                className="w-32"
                disabled={disabled}
              >
                <option value="send">{t("stepTypeSend")}</option>
                <option value="wait">{t("stepTypeWait")}</option>
              </Select>
              <span className="text-xs text-muted-foreground">{t("stepN", { n: i + 1 })}</span>
              <Button
                variant="ghost"
                size="icon"
                className="ms-auto"
                aria-label={t("removeStep")}
                onClick={() => onSteps(steps.filter((x) => x.rowId !== s.rowId))}
                disabled={disabled || steps.length === 1}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            {s.type === "send" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={t("titlePlaceholder")}
                  value={s.title}
                  onChange={(e) => updateStep(s.rowId, { title: e.target.value })}
                  placeholder={t("titlePlaceholder")}
                  disabled={disabled}
                />
                <Input
                  aria-label={t("bodyPlaceholder")}
                  value={s.body}
                  onChange={(e) => updateStep(s.rowId, { body: e.target.value })}
                  placeholder={t("bodyPlaceholder")}
                  disabled={disabled}
                />
              </div>
            ) : (
              <Input
                type="number"
                min={0}
                max={8760}
                aria-label={t("waitHoursPlaceholder")}
                value={s.hours}
                onChange={(e) => updateStep(s.rowId, { hours: e.target.value })}
                placeholder={t("waitHoursPlaceholder")}
                disabled={disabled}
              />
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => addStep("send")} disabled={disabled}>
            <Send aria-hidden="true" className="h-4 w-4" /> {t("addSend")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => addStep("wait")} disabled={disabled}>
            <Clock aria-hidden="true" className="h-4 w-4" /> {t("addWait")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * 저장 직전 스텝 정리. 타입에 맞지 않는 필드를 버려 서버 스키마와 어긋나지 않게 한다.
 * send 로 바꿨다가 wait 로 되돌린 스텝에 title 이 남아 있으면 그대로 저장된다.
 */
export function cleanSteps(steps: StepDraft[]): Step[] {
  return steps.map((s) =>
    s.type === "send"
      ? { type: "send" as const, title: s.title, body: s.body }
      : { type: "wait" as const, hours: Number(s.hours.trim()) || 0 }
  );
}
