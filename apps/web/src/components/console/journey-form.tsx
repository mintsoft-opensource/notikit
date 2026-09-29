"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { X, Send, Clock, GitBranch, CircleStop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FIELD_HINT_TEXT, Input, Label, Select, Field } from "@/components/ui/input";
import { newRowId } from "@/lib/row-id";
import {
  DEFAULT_BRANCH_HOURS,
  MAX_BRANCH_DEPTH,
  MAX_BRANCH_HOURS,
  MAX_STEP_NODES,
  entryEventOf,
  normalizeSteps,
  withEntryEvent,
  type JourneyStep,
} from "@/lib/journey-steps";

export type Step = JourneyStep;

export const EMPTY_STEPS: Step[] = [{ type: "send", title: "", body: "" }];

/**
 * 편집 중인 스텝. 숫자 칸은 문자열로 둔다 — 숫자로 들고 있으면 칸을 비우는 순간 0 이 되어
 * 지우고 다시 쓰는 흐름이 막힌다. 숫자 변환은 저장할 때(cleanDraft) 한 번만 한다.
 *
 * 스텝은 목록이 아니라 **트리**다. 분기의 두 갈래가 각자 자식 목록을 들고, 같은 편집
 * 규칙이 재귀로 적용된다.
 */
export type StepDraft =
  | { rowId: string; type: "send"; title: string; body: string }
  | { rowId: string; type: "wait"; hours: string }
  | { rowId: string; type: "branch"; withinHours: string; yes: StepDraft[]; no: StepDraft[] }
  | { rowId: string; type: "exit"; event: string };

/** 진입 조건은 스텝 행이 아니라 저니에 하나뿐인 설정이라 따로 들고 다닌다 */
export type JourneyDraft = { entry: string; steps: StepDraft[] };

const DEFAULT_WAIT_HOURS = "24";

function blank(type: StepDraft["type"]): StepDraft {
  const rowId = newRowId();
  if (type === "send") return { rowId, type, title: "", body: "" };
  if (type === "wait") return { rowId, type, hours: DEFAULT_WAIT_HOURS };
  if (type === "exit") return { rowId, type, event: "" };
  return { rowId, type, withinHours: String(DEFAULT_BRANCH_HOURS), yes: [], no: [] };
}

function toDrafts(steps: Step[]): StepDraft[] {
  return steps.flatMap((s): StepDraft[] => {
    const rowId = newRowId();
    if (s.type === "send") return [{ rowId, type: "send", title: s.title ?? "", body: s.body ?? "" }];
    if (s.type === "wait") return [{ rowId, type: "wait", hours: s.hours === undefined ? "" : String(s.hours) }];
    if (s.type === "exit") return [{ rowId, type: "exit", event: s.event ?? "" }];
    if (s.type === "branch") {
      return [
        {
          rowId,
          type: "branch",
          withinHours: String(s.withinHours ?? DEFAULT_BRANCH_HOURS),
          yes: toDrafts(s.yes ?? []),
          no: toDrafts(s.no ?? []),
        },
      ];
    }
    return []; // entry 는 행이 아니다 — toDraft 가 따로 떼어낸다
  });
}

export function toDraft(steps: Step[]): JourneyDraft {
  const tree = normalizeSteps(steps.length ? steps : EMPTY_STEPS);
  const body = tree[0]?.type === "entry" ? tree.slice(1) : tree;
  return { entry: entryEventOf(tree) ?? "", steps: toDrafts(body.length ? body : EMPTY_STEPS) };
}

/** 드래프트끼리 저장될 내용이 같은지 — rowId 는 화면용이라 비교에서 뺀다 */
export function sameDraft(a: JourneyDraft, b: JourneyDraft): boolean {
  return JSON.stringify(cleanDraft(a)) === JSON.stringify(cleanDraft(b));
}

/**
 * 저장 직전 정리. 타입에 맞지 않는 필드를 버려 서버 스키마와 어긋나지 않게 한다.
 * send 로 바꿨다가 wait 로 되돌린 스텝에 title 이 남아 있으면 그대로 저장된다.
 */
export function cleanDraft(draft: JourneyDraft): Step[] {
  return withEntryEvent(cleanSteps(draft.steps), draft.entry.trim() || null);
}

function cleanSteps(steps: StepDraft[]): Step[] {
  return steps.map((s): Step => {
    if (s.type === "send") return { type: "send", title: s.title, body: s.body };
    if (s.type === "wait") return { type: "wait", hours: Number(s.hours.trim()) || 0 };
    if (s.type === "exit") return { type: "exit", event: s.event.trim() };
    return {
      type: "branch",
      withinHours: Number(s.withinHours.trim()) || DEFAULT_BRANCH_HOURS,
      yes: cleanSteps(s.yes),
      no: cleanSteps(s.no),
    };
  });
}

// ─── 트리 편집 (불변) ────────────────────────────────────────────────────────

function mapTree(steps: StepDraft[], fn: (s: StepDraft) => StepDraft | null): StepDraft[] {
  const out: StepDraft[] = [];
  for (const s of steps) {
    const next = fn(s);
    if (!next) continue;
    out.push(next.type === "branch" ? { ...next, yes: mapTree(next.yes, fn), no: mapTree(next.no, fn) } : next);
  }
  return out;
}

function updateNode(steps: StepDraft[], rowId: string, patch: Partial<StepDraft>): StepDraft[] {
  return mapTree(steps, (s) => {
    if (s.rowId !== rowId) return s;
    // 타입이 바뀌면 **통째로** 갈아 끼운다. 병합하면 분기였던 행의 yes/no 가 보이지 않는
    // 채로 남아, 저장할 때 사라진 줄 알았던 갈래가 되살아난다.
    if (patch.type && patch.type !== s.type) return { ...(patch as StepDraft), rowId };
    return { ...s, ...patch } as StepDraft;
  });
}

function removeNode(steps: StepDraft[], rowId: string): StepDraft[] {
  return mapTree(steps, (s) => (s.rowId === rowId ? null : s));
}

/** parentRowId 가 null 이면 루트 목록 끝에, 아니면 그 분기의 갈래 끝에 붙인다 */
function addNode(steps: StepDraft[], parentRowId: string | null, arm: "yes" | "no", node: StepDraft): StepDraft[] {
  if (parentRowId === null) return [...steps, node];
  return mapTree(steps, (s) =>
    s.rowId === parentRowId && s.type === "branch" ? { ...s, [arm]: [...s[arm], node] } : s
  );
}

function countDrafts(steps: StepDraft[]): number {
  return steps.reduce((n, s) => n + 1 + (s.type === "branch" ? countDrafts(s.yes) + countDrafts(s.no) : 0), 0);
}

/** rowId 바로 앞 형제 — 행을 지운 뒤 초점이 갈 자리 */
function prevSibling(steps: StepDraft[], rowId: string): string | null {
  const i = steps.findIndex((s) => s.rowId === rowId);
  if (i > 0) return steps[i - 1].rowId;
  if (i === 0) return null;
  for (const s of steps) {
    if (s.type !== "branch") continue;
    const inArm = prevSibling(s.yes, rowId) ?? prevSibling(s.no, rowId);
    if (inArm) return inArm;
    // 갈래의 첫 행을 지웠으면 분기 자체로 돌아간다 — 초점이 화면 밖으로 튀지 않게
    if (s.yes.some((x) => x.rowId === rowId) || s.no.some((x) => x.rowId === rowId)) return s.rowId;
  }
  return null;
}

// ─── 검증 ───────────────────────────────────────────────────────────────────

export type StepErrors = Record<string, string>;

/**
 * 스텝 한 칸의 퍼널. `waiting` 은 **지금** 그 자리에 있는 실행 수이고 `sent`·`clicks` 는
 * 그 스텝이 지금까지 낸 발송의 **누적**이다 — 출처가 다르므로 서로의 분모가 아니다.
 */
export type StepStat = { waiting: number; sent: number; clicks: number };

/**
 * 칸별 오류. 저장 버튼 하나에 "저장 실패" 토스트만 띄우면 어느 칸이 문제인지 알 수 없다 —
 * 오류는 그 칸 바로 아래에 붙고(aria-describedby) 첫 오류로 초점이 간다.
 */
export function validateDraft(draft: JourneyDraft, t: (k: string) => string): StepErrors {
  const errors: StepErrors = {};
  const walk = (steps: StepDraft[]) => {
    for (const s of steps) {
      if (s.type === "send" && !s.title.trim()) errors[s.rowId] = t("errTitleRequired");
      else if (s.type === "send" && !s.body.trim()) errors[s.rowId] = t("errBodyRequired");
      if (s.type === "exit" && !s.event.trim()) errors[s.rowId] = t("errEventRequired");
      if (s.type === "wait" && s.hours.trim() !== "" && !Number.isFinite(Number(s.hours))) {
        errors[s.rowId] = t("errHoursInvalid");
      }
      if (s.type === "branch") {
        const h = Number(s.withinHours);
        if (!Number.isFinite(h) || h < 1 || h > MAX_BRANCH_HOURS) errors[s.rowId] = t("errHoursInvalid");
        walk(s.yes);
        walk(s.no);
      }
    }
  };
  walk(draft.steps);
  return errors;
}

// ─── 화면 ───────────────────────────────────────────────────────────────────

/**
 * 저니 입력 필드 — 생성 모달과 수정 화면이 **같은 컴포넌트**를 쓴다.
 * 따로 두면 한쪽에만 규칙이 추가되어 "생성은 되는데 수정하면 검증이 다른" 상태가 된다.
 */
export function JourneyFields({
  name,
  draft,
  onName,
  onDraft,
  idPrefix,
  errors,
  stepStats,
  nameLocked = false,
  disabled = false,
}: {
  name: string;
  draft: JourneyDraft;
  onName: (v: string) => void;
  onDraft: (v: JourneyDraft) => void;
  idPrefix: string;
  errors?: StepErrors;
  /** 스텝 경로별 퍼널 — 상세 화면에서만 넘어온다 */
  stepStats?: Record<string, StepStat>;
  /** 수정 화면에서는 이름을 잠근다 — SDK enroll 이 이름으로 저니를 찾는다 */
  nameLocked?: boolean;
  /** 저장 중에는 편집을 막는다 — 저장이 끝나며 서버 값으로 되맞출 때 그사이 고친 내용이 사라진다 */
  disabled?: boolean;
}) {
  const t = useTranslations("journeys");
  const rootRef = React.useRef<HTMLDivElement>(null);
  const [focusRow, setFocusRow] = React.useState<string | null>(null);

  /**
   * 행을 더하거나 지운 뒤 초점을 되돌린다. 추가 버튼에 초점이 남으면 새 행이 화면 어디에
   * 생겼는지 알 수 없고, 지운 뒤에는 초점이 body 로 떨어져 키보드 사용자가 처음부터
   * 탭을 다시 눌러야 한다.
   */
  React.useEffect(() => {
    if (!focusRow) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-row="${focusRow}"] input, [data-row="${focusRow}"] select`);
    el?.focus();
    setFocusRow(null);
  }, [focusRow, draft]);

  const total = countDrafts(draft.steps);
  const full = total >= MAX_STEP_NODES;

  function setSteps(steps: StepDraft[]) {
    onDraft({ ...draft, steps });
  }

  function add(parentRowId: string | null, arm: "yes" | "no", type: StepDraft["type"]) {
    const node = blank(type);
    setSteps(addNode(draft.steps, parentRowId, arm, node));
    setFocusRow(node.rowId);
  }

  function remove(rowId: string) {
    const back = prevSibling(draft.steps, rowId);
    setSteps(removeNode(draft.steps, rowId));
    if (back) setFocusRow(back);
    else rootRef.current?.querySelector<HTMLElement>(`[data-add="root"] button`)?.focus();
  }

  return (
    <div ref={rootRef} className="w-full space-y-4">
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

      {/* 진입 조건 — 비우면 예전처럼 API enroll 로만 들어온다 */}
      <Field label={t("entryLabel")} hint={t("entryHint")}>
        <Input
          id={`${idPrefix}-entry`}
          value={draft.entry}
          onChange={(e) => onDraft({ ...draft, entry: e.target.value })}
          placeholder={t("entryPlaceholder")}
          disabled={disabled}
        />
      </Field>

      <div className="space-y-4">
        <Label>{t("stepsLabel")}</Label>
        <StepList
          steps={draft.steps}
          parentRowId={null}
          arm="yes"
          depth={0}
          path=""
          onUpdate={(rowId, patch) => setSteps(updateNode(draft.steps, rowId, patch))}
          onRemove={remove}
          onAdd={add}
          errors={errors}
          stepStats={stepStats}
          disabled={disabled}
          full={full}
          canRemove={total > 1}
        />
      </div>
    </div>
  );
}

type ListProps = {
  steps: StepDraft[];
  parentRowId: string | null;
  arm: "yes" | "no";
  depth: number;
  path: string;
  onUpdate: (rowId: string, patch: Partial<StepDraft>) => void;
  onRemove: (rowId: string) => void;
  onAdd: (parentRowId: string | null, arm: "yes" | "no", type: StepDraft["type"]) => void;
  errors?: StepErrors;
  stepStats?: Record<string, StepStat>;
  disabled: boolean;
  full: boolean;
  canRemove: boolean;
};

function StepList(props: ListProps) {
  const t = useTranslations("journeys");
  const { steps, parentRowId, arm, depth, path, disabled, full } = props;
  const addKey = parentRowId === null ? "root" : `${parentRowId}-${arm}`;

  return (
    <div className="space-y-4">
      {steps.length === 0 && <p className={FIELD_HINT_TEXT}>{t("armEmpty")}</p>}
      {steps.map((s, i) => (
        <StepRow key={s.rowId} {...props} step={s} path={path ? `${path}.${i}` : String(i)} index={i} />
      ))}
      <div data-add={addKey} className="flex flex-wrap gap-4">
        <Button variant="outline" size="sm" onClick={() => props.onAdd(parentRowId, arm, "send")} disabled={disabled || full}>
          <Send aria-hidden="true" className="size-4" /> {t("addSend")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => props.onAdd(parentRowId, arm, "wait")} disabled={disabled || full}>
          <Clock aria-hidden="true" className="size-4" /> {t("addWait")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => props.onAdd(parentRowId, arm, "branch")}
          // 깊이 상한은 서버 검증과 같다 — 여기서 열어 두면 저장할 때만 422 가 난다
          disabled={disabled || full || depth >= MAX_BRANCH_DEPTH}
        >
          <GitBranch aria-hidden="true" className="size-4" /> {t("addBranch")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => props.onAdd(parentRowId, arm, "exit")} disabled={disabled || full}>
          <CircleStop aria-hidden="true" className="size-4" /> {t("addExit")}
        </Button>
      </div>
    </div>
  );
}

function StepRow(props: ListProps & { step: StepDraft; path: string; index: number }) {
  const t = useTranslations("journeys");
  const { step: s, path, index, errors, stepStats, disabled, onUpdate, onRemove, canRemove, depth } = props;
  const error = errors?.[s.rowId];
  const stat = stepStats?.[path];

  return (
    <div
      role="group"
      aria-label={t("stepGroup", { n: index + 1 })}
      data-row={s.rowId}
      className="w-full space-y-4 rounded-lg border border-border p-3.5"
    >
      <div className="flex items-center gap-4">
        <Select
          aria-label={t("stepType")}
          value={s.type}
          // 타입을 바꾸면 그 타입의 빈 행으로 갈아 끼운다. 필드를 남겨 두면 분기였던 행의
          // 갈래가 보이지 않는 채로 남아 저장될 때 되살아난다.
          onChange={(e) => onUpdate(s.rowId, blankPatch(e.target.value as StepDraft["type"]))}
          className="w-32"
          disabled={disabled}
        >
          <option value="send">{t("stepTypeSend")}</option>
          <option value="wait">{t("stepTypeWait")}</option>
          <option value="branch">{t("stepTypeBranch")}</option>
          <option value="exit">{t("stepTypeExit")}</option>
        </Select>
        <span className={FIELD_HINT_TEXT}>{t("stepN", { n: index + 1 })}</span>
        {stat && (
          /**
           * 한 줄에 세 축: 지금 머문 수(현재) · 이 스텝이 낸 발송(누적) · 클릭률.
           * 머문 수와 발송 수는 분모가 다르다 — 같은 줄에 두되 하나의 비율로 읽히지 않게
           * 각각 이름을 붙인다. 발송이 없던 스텝의 클릭률은 0% 가 아니라 "—" 다.
           */
          <span className={FIELD_HINT_TEXT}>
            {t("stepFunnel", {
              waiting: stat.waiting,
              sent: stat.sent,
              rate: stat.sent > 0 ? `${Math.round((stat.clicks / stat.sent) * 1000) / 10}%` : "—",
            })}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="ms-auto"
          aria-label={t("removeStep")}
          onClick={() => onRemove(s.rowId)}
          disabled={disabled || !canRemove}
        >
          <X aria-hidden="true" className="size-4" />
        </Button>
      </div>

      {s.type === "send" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("titlePlaceholder")} error={error}>
            <Input
              value={s.title}
              onChange={(e) => onUpdate(s.rowId, { title: e.target.value })}
              placeholder={t("titlePlaceholder")}
              disabled={disabled}
            />
          </Field>
          <Field label={t("bodyPlaceholder")}>
            <Input
              value={s.body}
              onChange={(e) => onUpdate(s.rowId, { body: e.target.value })}
              placeholder={t("bodyPlaceholder")}
              disabled={disabled}
            />
          </Field>
        </div>
      )}

      {s.type === "wait" && (
        <Field label={t("waitHoursPlaceholder")} error={error}>
          <Input
            type="number"
            min={0}
            max={8760}
            value={s.hours}
            onChange={(e) => onUpdate(s.rowId, { hours: e.target.value })}
            placeholder={t("waitHoursPlaceholder")}
            disabled={disabled}
          />
        </Field>
      )}

      {s.type === "exit" && (
        <Field label={t("exitEventLabel")} error={error} hint={t("exitHint")}>
          <Input
            value={s.event}
            onChange={(e) => onUpdate(s.rowId, { event: e.target.value })}
            placeholder={t("exitPlaceholder")}
            disabled={disabled}
          />
        </Field>
      )}

      {s.type === "branch" && (
        <div className="space-y-4">
          <Field label={t("branchWithinLabel")} error={error} hint={t("branchHint")}>
            <Input
              type="number"
              min={1}
              max={MAX_BRANCH_HOURS}
              value={s.withinHours}
              onChange={(e) => onUpdate(s.rowId, { withinHours: e.target.value })}
              disabled={disabled}
            />
          </Field>
          {/* 들여쓰기는 논리 속성으로 — RTL 로케일에서 갈래가 반대쪽으로 붙어야 한다 */}
          <div className="space-y-4 border-s-2 border-primary/40 ps-4">
            <Label>{t("branchYes")}</Label>
            <StepList {...props} steps={s.yes} parentRowId={s.rowId} arm="yes" depth={depth + 1} path={`${path}.yes`} />
          </div>
          <div className="space-y-4 border-s-2 border-border ps-4">
            <Label>{t("branchNo")}</Label>
            <StepList {...props} steps={s.no} parentRowId={s.rowId} arm="no" depth={depth + 1} path={`${path}.no`} />
          </div>
        </div>
      )}
    </div>
  );
}

function blankPatch(type: StepDraft["type"]): Partial<StepDraft> {
  const { rowId: _drop, ...rest } = blank(type);
  void _drop;
  return rest as Partial<StepDraft>;
}
