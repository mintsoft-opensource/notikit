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
import { adminApi } from "@/lib/admin-client";
import { ROLES, type Role } from "@/lib/user-roles";

type Member = { id: string; email: string; role: string; createdAt: string; isSelf: boolean };

/** org 멤버 관리 — owner/admin 만 변경 가능(서버에서 재검증), viewer 는 목록만 */
export function MembersPanel({ currentRole }: { currentRole?: string }) {
  const t = useTranslations("account");
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
  // 비동기 완료 시점의 최신 입력을 읽기 위한 거울
  const emailRef = React.useRef(email);
  emailRef.current = email;
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
    // 응답이 늦는 사이 새 드래프트를 치기 시작했다면 완료 시 그걸 지워서는 안 된다
    const submitted = email;
    setBusy(true);
    try {
      await adminApi("/api/admin/users", { method: "POST", body: JSON.stringify({ email, password, role }) });
      toast.success(t("created"));
      if (emailRef.current === submitted) {
        setEmail("");
        setPassword("");
        setRole("viewer");
        setOpen(false);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("createFailed"));
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(m: Member, next: string) {
    try {
      await adminApi(`/api/admin/users/${m.id}`, { method: "PATCH", body: JSON.stringify({ role: next }) });
      toast.success(t("roleChanged"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("roleChangeFailed"));
      await load(); // 서버가 거부했으면 화면을 실제 상태로 되돌린다
    }
  }

  async function remove(m: Member) {
    if (!confirm(t("confirmRemove", { email: m.email }))) return;
    try {
      await adminApi(`/api/admin/users/${m.id}`, { method: "DELETE" });
      toast.success(t("removed"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("removeFailed"));
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
                <Button variant="ghost" onClick={closeDialog}>{tc("cancel")}</Button>
                <Button type="submit" form="new-member-form" disabled={busy || !email || password.length < 8}>
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
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="member@example.com"
                />
              </Field>
              <Field label={t("passwordLabel")}>
                <Input
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={"\u2022".repeat(8)}
                />
              </Field>
              <Field label={t("roleLabel")}>
                <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
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
                  <TableCell label={t("colJoined")} className="col-start-1 row-start-2 text-xs tabular-nums text-muted-foreground lg:col-start-auto lg:row-start-auto lg:text-right">{df.format(new Date(m.createdAt))}</TableCell>
                  <TableCell label={t("colRole")} className="col-start-1 row-start-3 flex items-center gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:justify-end lg:col-start-3 lg:row-span-1">
                    {editable ? (
                      <Select
                        aria-label={t("roleLabel")}
                        value={m.role}
                        onChange={(e) => changeRole(m, e.target.value)}
                        className="h-8 w-28 text-xs"
                      >
                        {assignableRoles.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <span className="flex w-28 justify-center sm:mr-11"><Badge variant={m.role === "owner" ? "primary" : "neutral"}>{m.role}</Badge></span>
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
