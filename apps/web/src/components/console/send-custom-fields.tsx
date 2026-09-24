"use client";

import * as React from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";
import { newRowId } from "@/lib/row-id";
import type { TemplateField } from "@/lib/templates";
import type { MessageTemplate } from "./template-form";

/** rowId 는 화면 key 용 — 가운데 행을 지워도 아래 행 입력이 밀리지 않게 */
export type ExtraField = { rowId: string; key: string; value: string };

/**
 * 템플릿 고르기. 목록을 받아 오면 initialId(링크로 넘어온 템플릿)를 한 번 적용한다.
 * 적용 여부(덮어쓰기 확인)는 호출측이 정한다 — false 를 돌려주면 선택을 되돌린다.
 */
export function SendTemplatePicker({
  projectId,
  initialId,
  onApply,
}: {
  projectId: string;
  initialId?: string;
  onApply: (tpl: MessageTemplate | null, opts: { initial: boolean }) => boolean;
}) {
  const t = useTranslations("send");
  const [items, setItems] = React.useState<MessageTemplate[] | null>(null);
  const [selected, setSelected] = React.useState("");
  const appliedInitial = React.useRef(false);
  const onApplyRef = React.useRef(onApply);
  onApplyRef.current = onApply;

  React.useEffect(() => {
    let alive = true;
    adminApi<{ templates: MessageTemplate[] }>(`/api/admin/projects/${projectId}/templates`)
      .then((d) => {
        if (!alive) return;
        setItems(d.templates);
        const initial = initialId ? d.templates.find((x) => x.id === initialId) : undefined;
        if (initial && !appliedInitial.current) {
          appliedInitial.current = true;
          if (onApplyRef.current(initial, { initial: true })) setSelected(initial.id);
        }
      })
      .catch(() => alive && setItems([]));
    return () => { alive = false; };
  }, [projectId, initialId]);

  function change(id: string) {
    const tpl = items?.find((x) => x.id === id) ?? null;
    if (onApply(tpl, { initial: false })) setSelected(id);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="min-w-48 flex-1">
        <Field label={t("template")}>
          <Select value={selected} onChange={(e) => change(e.target.value)} disabled={!items}>
            <option value="">{t("noTemplate")}</option>
            {items?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      </div>
      <Button variant="outline" asChild>
        <Link href={`/projects/${projectId}/templates`}>{t("manageTemplates")}</Link>
      </Button>
    </div>
  );
}

/** 커스텀 필드(푸시 data) 입력 — 템플릿이 정한 필드 + 이번 발송에만 쓰는 자유 필드 */
export function SendCustomFields({
  fields,
  values,
  onValues,
  extras,
  onExtras,
}: {
  fields: TemplateField[];
  values: Record<string, string>;
  onValues: (v: Record<string, string>) => void;
  extras: ExtraField[];
  onExtras: (e: ExtraField[]) => void;
}) {
  const t = useTranslations("send");
  const setExtra = (rowId: string, patch: Partial<ExtraField>) =>
    onExtras(extras.map((x) => (x.rowId === rowId ? { ...x, ...patch } : x)));

  /**
   * 줄을 더하거나 지우면 누르고 있던 버튼·칸이 사라져 포커스가 body 로 떨어진다 —
   * 키보드 사용자는 폼 처음부터 다시 훑어야 한다. topic-rules-form 과 같은 pendingFocus 방식:
   * 다음 렌더에서 갈 곳(새 줄의 키 칸 / 남은 앞줄 / 없으면 "추가" 버튼)으로 옮긴다.
   */
  const keyInputRefs = React.useRef(new Map<string, HTMLInputElement>());
  const addRef = React.useRef<HTMLButtonElement>(null);
  const pendingFocus = React.useRef<string | null>(null);
  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    (keyInputRefs.current.get(target) ?? addRef.current)?.focus();
  }, [extras]);

  const addExtra = () => {
    const next: ExtraField = { rowId: newRowId(), key: "", value: "" };
    pendingFocus.current = next.rowId;
    onExtras([...extras, next]);
  };

  const removeExtra = (index: number) => {
    const rest = extras.filter((_, i) => i !== index);
    pendingFocus.current = rest[Math.max(0, index - 1)]?.rowId ?? ""; // 남은 줄이 없으면 "추가" 버튼
    onExtras(rest);
  };

  return (
    <div className="space-y-3">
      {fields.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {fields.map((f) => (
            <Field key={f.key} label={`${f.label || f.key}${f.required ? " *" : ""}`} hint={f.label ? f.key : undefined}>
              <Input
                spellCheck={false}
                value={values[f.key] ?? ""}
                onChange={(e) => onValues({ ...values, [f.key]: e.target.value })}
                placeholder={f.default ?? ""}
              />
            </Field>
          ))}
        </div>
      )}

      {/*
        줄마다 이름이 전부 "필드 키"/"필드 값"이면 스크린리더의 폼 요소 목록에서 줄을 구분할 수
        없다(WCAG 2.4.6). 이름에 줄 번호를 넣고, 값 칸은 키가 채워졌으면 그 키를 대신 쓴다.
      */}
      {extras.map((x, i) => (
        <div key={x.rowId} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto] items-center gap-2">
          <Input
            ref={(el) => {
              if (el) keyInputRefs.current.set(x.rowId, el);
              else keyInputRefs.current.delete(x.rowId);
            }}
            aria-label={t("extraKeyRow", { n: i + 1 })}
            className="font-mono"
            spellCheck={false}
            value={x.key}
            onChange={(e) => setExtra(x.rowId, { key: e.target.value })}
            placeholder={t("extraKeyPlaceholder")}
          />
          <Input
            aria-label={x.key.trim() ? t("extraValueNamed", { key: x.key.trim() }) : t("extraValueRow", { n: i + 1 })}
            spellCheck={false}
            value={x.value}
            onChange={(e) => setExtra(x.rowId, { value: e.target.value })}
            placeholder={t("extraValuePlaceholder")}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={x.key.trim() ? t("removeExtraNamed", { key: x.key.trim() }) : t("removeExtra")}
            onClick={() => removeExtra(i)}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <Button ref={addRef} type="button" variant="outline" size="sm" onClick={addExtra}>
          <Plus aria-hidden="true" className="h-4 w-4" /> {t("addExtra")}
        </Button>
        <span className="text-xs text-muted-foreground">{t("customFieldsHint")}</span>
      </div>
    </div>
  );
}
