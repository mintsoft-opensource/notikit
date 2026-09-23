"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { UserPlus, Trash2, Users } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Select, Field } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { DataTable, TableHeader, TableBody, TableRow, TableCell } from "@/components/ui/data-table";
import { Dialog } from "@/components/ui/dialog";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";
import { ROLES, type Role } from "@/lib/user-roles";

const PASSWORD_MIN = 8;

type Member = { id: string; email: string; role: string; createdAt: string; isSelf: boolean };

/** org 멤버 관리 — owner/admin 만 변경 가능(서버에서 재검증), viewer 는 목록만 */
export function MembersPanel({ currentRole }: { currentRole?: string }) {
  const t = useTranslations("account");
  const errorText = useAdminErrorText();
  const tc = useTranslations("common");
  const locale = useLocale();
  const canManage = currentRole === "owner" || currentRole === "admin";
  const assignableRoles = React.useMemo<Role[]>(
    () => (currentRole === "owner" ? [...ROLES] : ROLES.filter((r) => r !== "owner")),
    [currentRole]
  );

  const [members, setMembers] = React.useState<Member[] | null>(null);
  const [error, setError] = React.useState(false);
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [role, setRole] = React.useState<Role>("viewer");
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  /**
   * 드래프트(이메일·비밀번호·역할)가 바뀔 때마다 올린다. 생성 응답을 기다리는 사이 무엇이든 고쳤다면
   * 완료 시 지우지 않는다 — 이메일만 비교하면 비밀번호·역할만 고친 경우를 놓친다.
   */
  const revisionRef = React.useRef(0);
  const editEmail = (v: string) => { revisionRef.current++; setEmail(v); };
  const editPassword = (v: string) => { revisionRef.current++; setPassword(v); };
  const editRole = (v: Role) => { revisionRef.current++; setRole(v); };
  /** 역할 변경이 진행 중인 멤버 — 응답 전에 또 바꾸면 요청 순서가 뒤집혀 옛 역할이 남을 수 있다 */
  const [pendingRoles, setPendingRoles] = React.useState<ReadonlySet<string>>(() => new Set());
  const pendingRef = React.useRef<ReadonlySet<string>>(new Set());
  const setPending = (id: string, on: boolean) => {
    const next = new Set(pendingRef.current);
    if (on) next.add(id);
    else next.delete(id);
    pendingRef.current = next;
    setPendingRoles(next);
  };
  const df = React.useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);

  const load = React.useCallback(async () => {
    try {
      const d = await adminApi<{ users: Member[] }>("/api/admin/users");
      setMembers(d.users);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function closeDialog() {
    if (busy) return;
    // role 만 바꾼 것도 입력이다 — 안 물어보고 닫으면 고른 값이 조용히 사라진다
    const dirty = email.trim() !== "" || password !== "" || role !== "viewer";
    if (dirty && !confirm(tc("unsavedConfirm"))) return;
    setOpen(false);
    setEmail("");
    setPassword("");
    setRole("viewer");
  }

  async function create(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    // 제출 시점의 리비전을 기억한다 — 응답이 늦는 사이 드래프트를 고쳤다면 완료 시 지우지 않는다
    const submitted = revisionRef.current;
    setBusy(true);
    try {
      await adminApi("/api/admin/users", { method: "POST", body: JSON.stringify({ email, password, role }) });
      toast.success(t("created"));
      if (revisionRef.current === submitted) {
        setEmail("");
        setPassword("");
        setRole("viewer");
        setOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(errorText(err, t("createFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: Member, next: string) {
    if (pendingRef.current.has(m.id)) return;
    setPending(m.id, true);
    try {
      await adminApi(`/api/admin/users/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      toast.success(t("roleChanged"));
      await load();
    } catch (err) {
      toast.error(errorText(err, t("roleChangeFailed")));
      await load(); // 서버가 거부했으면 화면을 실제 상태로 되돌린다
    } finally {
      setPending(m.id, false);
    }
  }

  async function remove(m: Member) {
    if (!confirm(t("confirmRemove", { email: m.email }))) return;
    try {
      await adminApi(`/api/admin/users/${m.id}`, { method: "DELETE" });
      toast.success(t("removed"));
      await load();
    } catch (err) {
      toast.error(errorText(err, t("removeFailed")));
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{t("membersTitle")}</CardTitle>
          <CardDescription>{canManage ? t("membersDesc") : t("readOnlyNote")}</CardDescription>
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setOpen(true)}>
            <UserPlus aria-hidden="true" className="h-4 w-4" /> {t("addMember")}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {canManage && (
          <Dialog
            open={open}
            onClose={closeDialog}
            title={t("addMember")}
            description={t("membersDesc")}
            footer={
              <>
                <Button variant="ghost" onClick={closeDialog} disabled={busy}>{tc("cancel")}</Button>
                <Button type="submit" form="new-member-form" disabled={busy || !email || password.length < PASSWORD_MIN}>
                  <UserPlus aria-hidden="true" className="h-4 w-4" /> {busy ? t("creating") : t("create")}
                </Button>
              </>
            }
          >
            <form id="new-member-form" onSubmit={create} className="space-y-3">
              <Field label={t("emailLabel")}>
                <Input
                  id="new-member-email"
                  type="email"
                  required
                  spellCheck={false}
                  autoComplete="off"
                  value={email}
                  onChange={(e) => editEmail(e.target.value)}
                  placeholder="member@example.com"
                />
              </Field>
              {/* 길이 규칙은 라벨에 있다. 힌트는 입력 중 모자란 글자 수만 알린다 — 등록 버튼이 왜 꺼져 있는지 보이게 */}
              <Field
                label={t("passwordLabel")}
                hint={password.length > 0 && password.length < PASSWORD_MIN ? t("passwordHint", { remaining: PASSWORD_MIN - password.length }) : undefined}
              >
                <Input
                  type="password"
                  required
                  minLength={PASSWORD_MIN}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => editPassword(e.target.value)}
                  placeholder={"\u2022".repeat(8)}
                />
              </Field>
              <Field label={t("roleLabel")}>
                <Select value={role} onChange={(e) => editRole(e.target.value as Role)}>
                  {assignableRoles.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </Select>
              </Field>
              <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
            </form>
          </Dialog>
        )}

        {members === null ? (
          error ? <EmptyState icon={Users} title={tc("loadFailed")} /> : <div className="space-y-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
        ) : members.length === 0 ? (
          <EmptyState icon={Users} title={t("empty")} />
        ) : (
          <div className="overflow-hidden border border-border">
          <DataTable label={t("membersTitle")} rowCount={members.length + 1}>
          <TableHeader
            grid="lg:grid-cols-[minmax(0,1fr)_12rem_12rem]"
            show="lg"
            columns={[
              { label: t("colMember") },
              { label: t("colJoined"), align: "end" },
              { label: t("colRole") },
            ]}
          />
          <TableBody>
            {members.map((m) => {
              // owner 계정은 owner 만 변경 가능 — 서버 규칙을 UI 에도 반영
              const editable = canManage && !m.isSelf && (m.role !== "owner" || currentRole === "owner");
              return (
                <TableRow key={m.id} className="grid min-h-14 grid-cols-1 items-center gap-x-4 gap-y-1 px-3.5 py-2 transition-colors hover:bg-surface-muted/30 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_12rem_12rem]">
                  <TableCell label={t("colMember")} className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      <span className="truncate">{m.email}</span>
                      {m.isSelf && <Badge variant="neutral">{t("you")}</Badge>}
                    </p>
                  </TableCell>
                  <TableCell label={t("colJoined")} className="col-start-1 row-start-2 text-xs tabular-nums text-muted-foreground lg:col-start-auto lg:row-start-auto lg:text-end">{df.format(new Date(m.createdAt))}</TableCell>
                  <TableCell label={t("colRole")} className="col-start-1 row-start-3 flex items-center gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-end lg:col-start-3 lg:row-span-1">
                    {editable ? (
                      <Select
                        aria-label={t("roleLabel")}
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value)}
                        disabled={pendingRoles.has(m.id)}
                        aria-busy={pendingRoles.has(m.id) || undefined}
                        className="w-28 text-xs"
                      >
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="flex w-28 justify-center sm:me-11"><Badge variant={m.role === "owner" ? "primary" : "neutral"}>{m.role}</Badge></span>
                    )}
                    {editable && (
                      <Button variant="ghost" size="icon" aria-label={t("remove")} onClick={() => remove(m)}>
                        <Trash2 aria-hidden="true" className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          </DataTable>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
