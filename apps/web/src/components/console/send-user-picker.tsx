"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, Plus, Search, UserRound, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";

/** 고른 사용자 — 미리보기 치환에 속성이 필요해서 아이디만이 아니라 속성까지 들고 다닌다 */
export type PickedUser = { externalId: string; attributes: Record<string, unknown> | null };

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
        <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-md border border-border bg-surface p-1.5 shadow-sm">
          {value.map((u) => (
            <span key={u.externalId} className="inline-flex max-w-full items-center gap-1 rounded-md bg-accent-soft py-0.5 pl-2 pr-1 font-mono text-xs">
              <span className="truncate">{u.externalId}</span>
              <button
                type="button"
                aria-label={t("removeUser", { id: u.externalId })}
                onClick={() => onChange(value.filter((v) => v.externalId !== u.externalId))}
                className="grid h-4 w-4 place-items-center rounded-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Plus aria-hidden="true" className="h-3.5 w-3.5" /> {t("addUsers")}
          </button>
        </div>
      ) : (
        <div className="relative">
          <button
            type="button"
            aria-labelledby={labelId}
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="flex h-9 w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 pr-9 text-left text-sm shadow-sm hover:bg-surface-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
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
              className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X aria-hidden="true" className="h-3.5 w-3.5" />
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

function UserSearchDialog({
  open,
  projectId,
  multiple,
  initial,
  onClose,
  onDone,
}: {
  open: boolean;
  projectId: string;
  multiple: boolean;
  initial: PickedUser[];
  onClose: () => void;
  onDone: (users: PickedUser[]) => void;
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
  const reqRef = React.useRef(0);
  const initialRef = React.useRef(initial);
  initialRef.current = initial;

  React.useEffect(() => {
    if (!open) return;
    const my = ++reqRef.current;
    const timer = setTimeout(() => {
      setFailed(false);
      adminApi<{ users: UserHit[] }>(`/api/admin/projects/${projectId}/audience/users?q=${encodeURIComponent(q.trim())}`)
        .then((d) => my === reqRef.current && setUsers(d.users))
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

  function pick(u: UserHit) {
    const picked = { externalId: u.externalId, attributes: u.attributes };
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
      title={t("pickUser")}
      description={multiple ? t("maxUsers", { max: MAX_PICK }) : t("pickUserHint")}
      footer={
        multiple ? (
          <>
            <Button variant="ghost" onClick={onClose}>{tc("cancel")}</Button>
            <Button onClick={() => onDone(draft)}>{t("pickDone", { count: draft.length })}</Button>
          </>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label={t("pickUser")}
            className="pl-9"
            spellCheck={false}
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("userSearchPlaceholder")}
          />
        </div>

        <div className="max-h-80 overflow-y-auto rounded-tile border border-border">
          {failed ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{tc("loadFailed")}</p>
          ) : !users ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{tc("loading")}</p>
          ) : users.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">{t("noUsersFound")}</p>
          ) : (
            <ul className="divide-y divide-border">
              {users.map((u) => {
                const on = chosen.has(u.externalId);
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      aria-pressed={multiple ? on : undefined}
                      disabled={multiple && !on && full}
                      onClick={() => pick(u)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-muted/50 focus-visible:bg-surface-muted/50 focus-visible:outline-none disabled:opacity-50"
                    >
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${on ? "bg-primary text-primary-foreground" : "bg-accent-soft text-primary"}`}>
                        {on ? <Check aria-hidden="true" className="h-4 w-4" /> : <UserRound aria-hidden="true" className="h-4 w-4" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-sm font-semibold">{u.externalId}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t("userDevices", { count: u.deviceCount })}
                          {u.phone ? ` · ${u.phone}` : ""}
                          {u.lastActiveAt ? ` · ${df.format(new Date(u.lastActiveAt))}` : ""}
                        </span>
                      </span>
                    </button>
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
