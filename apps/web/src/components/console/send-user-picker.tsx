"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, Plus, Search, UserRound, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";
import { FIELD_FOCUS_RING, FOCUS_RING } from "@/components/ui/focus-ring";
import { cn } from "@/lib/utils";

/** 고른 사용자 — 미리보기 치환에 속성이 필요해서 아이디만이 아니라 속성까지 들고 다닌다 */
export type PickedUser = {
  externalId: string;
  name: string | null;
  attributes: Record<string, unknown> | null;
  timezone: string | null;
  locale: string | null;
};

type UserHit = PickedUser & { id: string; phone: string | null; deviceCount: number; lastActiveAt: string | null };

const SEARCH_DEBOUNCE_MS = 250;
export const MAX_PICK = 1000;

/**
 * 개별·다중 발송의 받는 사람 — 아이디를 손으로 치게 두면 오타가 "기기 0대로 성공"이 된다.
 * 실제로 등록된 사용자 중에서 고르게 한다.
 */
export function SendUserPicker({
  projectId,
  multiple = false,
  value,
  onChange,
}: {
  projectId: string;
  multiple?: boolean;
  value: PickedUser[];
  onChange: (users: PickedUser[]) => void;
}) {
  const t = useTranslations("send");
  const [open, setOpen] = React.useState(false);
  const labelId = React.useId();

  return (
    <div className="space-y-1">
      <Label id={labelId}>{multiple ? t("targetUsersCount", { count: value.length }) : t("targetUser")}</Label>
      {multiple ? (
        <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-1 shadow-sm">
          {value.map((u) => (
            // 칸 안의 조작 요소(칩 X·사용자 추가)는 D3 규칙 — h-7·rounded-md, 아이콘은 size-4
            <span key={u.externalId} className="inline-flex h-7 max-w-full items-center gap-0.5 rounded-md bg-accent-soft ps-2 font-mono text-xs">
              <span className="truncate">{u.name ? `${u.name} · ${u.externalId}` : u.externalId}</span>
              <button
                type="button"
                aria-label={t("removeUser", { id: u.externalId })}
                onClick={() => onChange(value.filter((v) => v.externalId !== u.externalId))}
                className={cn("grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-surface-muted hover:text-foreground", FOCUS_RING)}
              >
                <X aria-hidden="true" className="size-4" />
              </button>
            </span>
          ))}
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-semibold text-primary hover:bg-accent-soft", FOCUS_RING)}
          >
            <Plus aria-hidden="true" className="size-4" /> {t("addUsers")}
          </button>
        </div>
      ) : (
        <div className="relative">
          <button
            type="button"
            aria-labelledby={labelId}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className={cn(
              "flex h-9 w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 pe-9 text-start text-sm shadow-sm hover:bg-surface-muted/40",
              FIELD_FOCUS_RING
            )}
          >
            <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {value[0] ? (
              <span className="truncate font-mono">{value[0].externalId}</span>
            ) : (
              <span className="truncate text-muted-foreground">{t("pickUserPlaceholder")}</span>
            )}
          </button>
          {value[0] && (
            <button
              type="button"
              aria-label={t("clearUser")}
              onClick={() => onChange([])}
              // 칸(36px) 안에 겹쳐 놓는 지우기 버튼 — 칸 안 요소 규칙(D3) 28px, 아이콘은 size-4
              className={cn("absolute end-1 top-1/2 grid h-7 w-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-surface-muted", FOCUS_RING)}
            >
              <X aria-hidden="true" className="size-4" />
            </button>
          )}
        </div>
      )}
      <UserSearchDialog
        open={open}
        projectId={projectId}
        multiple={multiple}
        initial={value}
        onClose={() => setOpen(false)}
        onDone={(users) => {
          onChange(users);
          setOpen(false);
        }}
      />
    </div>
  );
}

export function UserSearchDialog({
  open,
  projectId,
  multiple,
  initial,
  onClose,
  onDone,
  title,
  description,
}: {
  open: boolean;
  projectId: string;
  multiple: boolean;
  initial: PickedUser[];
  onClose: () => void;
  onDone: (users: PickedUser[]) => void;
  title?: string;
  description?: string;
}) {
  const t = useTranslations("send");
  const tc = useTranslations("common");
  const locale = useLocale();
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }), [locale]);
  const [q, setQ] = React.useState("");
  const [users, setUsers] = React.useState<UserHit[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  // 다중 선택은 팝업 안에서 고르다가 "선택"을 눌러야 반영된다 — 닫으면 취소
  const [draft, setDraft] = React.useState<PickedUser[]>([]);
  /** 방향키로 가리키는 결과 — 포커스는 입력칸에 두고 aria-activedescendant 로 알린다 */
  const [active, setActive] = React.useState(-1);
  const listId = React.useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const reqRef = React.useRef(0);
  const initialRef = React.useRef(initial);
  initialRef.current = initial;

  React.useEffect(() => {
    if (!open) return;
    const my = ++reqRef.current;
    const timer = setTimeout(() => {
      setFailed(false);
      adminApi<{ users: UserHit[] }>(`/api/admin/projects/${projectId}/audience/users?q=${encodeURIComponent(q.trim())}`)
        .then((d) => {
          if (my !== reqRef.current) return;
          setUsers(d.users);
          setActive(-1);
        })
        .catch(() => my === reqRef.current && setFailed(true));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, q, projectId]);

  // 열 때의 선택으로 시작하고, 닫으면 검색을 비운다
  React.useEffect(() => {
    if (open) {
      setDraft(initialRef.current);
      return;
    }
    setQ("");
    setUsers(null);
  }, [open]);

  const chosen = new Set(draft.map((u) => u.externalId));
  const full = draft.length >= MAX_PICK;
  const hasResults = Boolean(users && users.length > 0 && !failed);
  const isDisabled = (u: UserHit) => multiple && !chosen.has(u.externalId) && full;

  React.useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active, listId]);

  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!users || !hasResults) return;
    const last = users.length - 1;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i >= last ? 0 : i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i <= 0 ? last : i - 1));
    } else if (e.key === "Enter" && active >= 0 && users[active]) {
      e.preventDefault();
      if (!isDisabled(users[active])) pick(users[active]);
    }
  }

  function pick(u: UserHit) {
    const picked = { externalId: u.externalId, name: u.name, attributes: u.attributes, timezone: u.timezone, locale: u.locale };
    if (!multiple) return onDone([picked]);
    setDraft((d) =>
      d.some((x) => x.externalId === u.externalId)
        ? d.filter((x) => x.externalId !== u.externalId)
        : d.length >= MAX_PICK
          ? d
          : [...d, picked]
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title ?? t("pickUser")}
      description={description ?? (multiple ? t("maxUsers", { max: MAX_PICK }) : t("pickUserHint"))}
      footer={
        multiple ? (
          <>
            <Button variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
            <Button onClick={() => onDone(draft)}>{t("pickDone", { count: draft.length })}</Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-4">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            role="combobox"
            aria-label={t("pickUser")}
            aria-expanded={hasResults}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={hasResults && active >= 0 ? optionId(active) : undefined}
            onKeyDown={onSearchKeyDown}
            className="ps-9"
            spellCheck={false}
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("userSearchPlaceholder")}
          />
        </div>

        {/*
          결과 수·로딩·"없음" 을 알린다. 아래 목록은 입력칸(combobox)이 조종하므로 포커스가
          옮겨가지 않고, 화면을 보지 않는 사용자에게는 타이핑에 아무 반응이 없는 것처럼 느껴진다
          (WCAG 4.1.3).

          알림 문구는 **보이는 문구와 같은 말을 쓰지 않는다**. 같은 문장을 두 군데 두면 이 영역과
          아래 목록이 한 화면에 나란히 존재하게 되어, 스크린리더는 결과를 두 번 듣고 화면 테스트는
          같은 문구를 두 개 찾는다. 여기는 "결과가 몇 건인가"만 말하고, 무엇을 해야 하는지는
          아래 보이는 문구가 말한다.
        */}
        <p role="status" aria-live="polite" className="sr-only">
          {failed
            ? t("searchResultFailed")
            : !users
              ? t("searchResultLoading")
              : t("searchResultCount", { count: users.length })}
        </p>

        <div className="max-h-80 overflow-y-auto rounded-tile border border-border">
          {failed ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{tc("loadFailed")}</p>
          ) : !users ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{tc("loading")}</p>
          ) : users.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t("noUsersFound")}</p>
          ) : (
            // 결과는 입력칸이 조종하는 listbox — 옵션에 포커스를 옮기지 않으므로 mousedown 으로 입력칸 포커스를 지킨다
            <ul id={listId} role="listbox" aria-label={t("pickUser")} aria-multiselectable={multiple || undefined} className="divide-y divide-border">
              {users.map((u, i) => {
                const on = chosen.has(u.externalId);
                const off = isDisabled(u);
                return (
                  <li
                    key={u.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={multiple ? on : i === active}
                    aria-disabled={off || undefined}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => !off && pick(u)}
                    className={`flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-start ${i === active ? "bg-surface-muted/50" : ""} ${off ? "cursor-not-allowed opacity-50" : ""}`}
                  >
                      <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full ${on ? "bg-primary text-primary-foreground" : "bg-accent-soft text-primary"}`}>
                        {on ? <Check aria-hidden="true" className="size-4" /> : <UserRound aria-hidden="true" className="size-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        {u.name && <span className="block truncate text-sm font-semibold">{u.name}</span>}
                        <span className={u.name ? "block truncate font-mono text-xs text-muted-foreground" : "block truncate font-mono text-sm font-semibold"}>{u.externalId}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("userDevices", { count: u.deviceCount })}
                          {u.phone ? ` · ${u.phone}` : ""}
                          {u.lastActiveAt ? ` · ${df.format(new Date(u.lastActiveAt))}` : ""}
                        </span>
                      </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Dialog>
  );
}
