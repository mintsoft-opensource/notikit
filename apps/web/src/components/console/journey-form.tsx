"use client";

import { useTranslations } from "next-intl";
import { X, Send, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Field } from "@/components/ui/input";

export type Step = { type: "send" | "wait"; title?: string; body?: string; hours?: number };

export const EMPTY_STEPS: Step[] = [{ type: "send", title: "", body: "" }];

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
}: {
  name: string;
  steps: Step[];
  onName: (v: string) => void;
  onSteps: (v: Step[]) => void;
  idPrefix: string;
  /** 수정 화면에서는 이름을 잠근다 — SDK enroll 이 이름으로 저니를 찾는다 */
  nameLocked?: boolean;
}) {
  const t = useTranslations("journeys");

  function updateStep(i: number, patch: Partial<Step>) {
    onSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
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
          disabled={nameLocked}
        />
      </Field>
      <div className="space-y-2">
        <Label>{t("stepsLabel")}</Label>
        {steps.map((s, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Select
                aria-label={t("stepType")}
                value={s.type}
                onChange={(e) => updateStep(i, { type: e.target.value as Step["type"] })}
                className="w-32"
              >
                <option value="send">send</option>
                <option value="wait">wait</option>
              </Select>
              <span className="text-xs text-muted-foreground">{t("stepN", { n: i + 1 })}</span>
              <Button
                variant="ghost"
                size="icon"
                className="ml-auto"
                aria-label={t("removeStep")}
                onClick={() => onSteps(steps.filter((_, j) => j !== i))}
                disabled={steps.length === 1}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </Button>
            </div>
            {s.type === "send" ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={t("titlePlaceholder")}
                  value={s.title ?? ""}
                  onChange={(e) => updateStep(i, { title: e.target.value })}
                  placeholder={t("titlePlaceholder")}
                />
                <Input
                  aria-label={t("bodyPlaceholder")}
                  value={s.body ?? ""}
                  onChange={(e) => updateStep(i, { body: e.target.value })}
                  placeholder={t("bodyPlaceholder")}
                />
              </div>
            ) : (
              <Input
                type="number"
                min={0}
                max={8760}
                aria-label={t("waitHoursPlaceholder")}
                value={s.hours ?? ""}
                onChange={(e) => updateStep(i, { hours: Number(e.target.value) })}
                placeholder={t("waitHoursPlaceholder")}
              />
            )}
          </div>
        ))}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onSteps([...steps, { type: "send", title: "", body: "" }])}>
            <Send aria-hidden="true" className="h-4 w-4" /> {t("addSend")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => onSteps([...steps, { type: "wait", hours: 24 }])}>
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
export function cleanSteps(steps: Step[]): Step[] {
  return steps.map((s) =>
    s.type === "send"
      ? { type: "send" as const, title: s.title ?? "", body: s.body ?? "" }
      : { type: "wait" as const, hours: Number(s.hours) || 0 }
  );
}
