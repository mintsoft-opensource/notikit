"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Copy, KeyRound, RotateCw, Trash2 } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabPanel } from "@/components/ui/tabs";
import { FIELD_HINT_TEXT } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { adminApi, useAdminErrorText } from "@/lib/admin-client";

type Status = { issued: boolean; created_at: string | null };
type Client = "claudeCode" | "cursor" | "claudeDesktop";

const TOOLS = ["get_project", "get_integration_snippet", "send_test_push", "list_recent_sends", "get_openapi"] as const;
/** 토큰을 아직 모를 때 설정에 넣는 자리표시 — 번역하지 않는다(붙여 넣는 값의 자리다) */
const TOKEN_PLACEHOLDER = "<MCP_TOKEN>";

function configFor(client: Client, url: string, token: string): string {
  const auth = `Authorization: Bearer ${token}`;
  if (client === "claudeCode") {
    return `claude mcp add --transport http notikit ${url} \\\n  --header "${auth}"`;
  }
  if (client === "cursor") {
    return JSON.stringify({ mcpServers: { notikit: { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  }
  // Claude Desktop 설정 파일은 원격 주소에 헤더를 직접 붙일 수 없어 mcp-remote 로 잇는다
  return JSON.stringify(
    { mcpServers: { notikit: { command: "npx", args: ["-y", "mcp-remote", url, "--header", auth] } } },
    null,
    2
  );
}

export function McpConsole({ projectId }: { projectId: string }) {
  const t = useTranslations("mcp");
  const tc = useTranslations("common");
  const locale = useLocale();
  const errorText = useAdminErrorText();
  /** null = 불러오는 중 */
  const [status, setStatus] = React.useState<Status | null>(null);
  /** 방금 발급한 토큰 — 이 화면을 떠나면 다시 볼 수 없다 */
  const [token, setToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<"reissue" | "revoke" | null>(null);
  const [client, setClient] = React.useState<Client>("claudeCode");
  const [origin, setOrigin] = React.useState("");

  React.useEffect(() => setOrigin(window.location.origin), []);

  React.useEffect(() => {
    let alive = true;
    setStatus(null);
    setToken(null);
    adminApi<Status>(`/api/admin/projects/${projectId}/mcp-token`)
      .then((d) => alive && setStatus(d))
      .catch((e) => {
        if (!alive) return;
        setStatus({ issued: false, created_at: null });
        toast.error(errorText(e, tc("loadFailed")));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function issue() {
    if (busy) return;
    setBusy(true);
    try {
      const d = await adminApi<{ token: string; created_at: string }>(`/api/admin/projects/${projectId}/mcp-token`, {
        method: "POST",
        body: "{}",
      });
      setToken(d.token);
      setStatus({ issued: true, created_at: d.created_at });
      toast.success(t("issued"));
    } catch (e) {
      toast.error(errorText(e, t("issueFailed")));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function revoke() {
    if (busy) return;
    setBusy(true);
    try {
      await adminApi(`/api/admin/projects/${projectId}/mcp-token`, { method: "DELETE" });
      setToken(null);
      setStatus({ issued: false, created_at: null });
      toast.success(t("revoked"));
    } catch (e) {
      toast.error(errorText(e, t("revokeFailed")));
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  async function copy(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(message);
    } catch {
      toast.error(tc("copyFailed"));
    }
  }

  const url = `${origin}/api/mcp`;
  const config = configFor(client, url, token ?? TOKEN_PLACEHOLDER);
  const issuedAt = status?.created_at
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(status.created_at))
    : null;

  return (
    <div className="w-full space-y-4">
      <PageHeader title={t("title")} description={t("subtitle")} />

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{t("tokenTitle")}</CardTitle>
            <CardDescription>{t("tokenHint")}</CardDescription>
          </div>
          {status && (
            <Badge variant={status.issued ? "success" : "neutral"}>
              {status.issued && issuedAt ? t("tokenIssuedAt", { date: issuedAt }) : t("tokenNone")}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {!status ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {status.issued ? (
                <>
                  <Button variant="outline" onClick={() => setConfirm("reissue")} disabled={busy}>
                    <RotateCw aria-hidden="true" /> {t("reissue")}
                  </Button>
                  <Button variant="outline" onClick={() => setConfirm("revoke")} disabled={busy}>
                    <Trash2 aria-hidden="true" /> {t("revoke")}
                  </Button>
                </>
              ) : (
                <Button onClick={issue} disabled={busy}>
                  <KeyRound aria-hidden="true" /> {busy ? tc("loading") : t("issue")}
                </Button>
              )}
            </div>
          )}
          {token && (
            <div className="flex items-center justify-between gap-3 rounded-lg bg-accent-soft py-1.5 ps-3.5 pe-1.5">
              <div className="min-w-0">
                <p className="text-xs font-semibold text-primary">{t("tokenOnce")}</p>
                <p className="truncate font-mono text-xs text-foreground" translate="no">{token}</p>
              </div>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => copy(token, t("tokenCopied"))}>
                <Copy aria-hidden="true" /> {tc("copy")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{t("connectTitle")}</CardTitle>
            <CardDescription>{token ? t("connectHintFilled") : t("connectHint", { placeholder: TOKEN_PLACEHOLDER })}</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs<Client>
            value={client}
            onChange={setClient}
            label={t("clientsLabel")}
            idPrefix="mcp-client"
            items={[
              { value: "claudeCode", label: "Claude Code" },
              { value: "cursor", label: "Cursor" },
              { value: "claudeDesktop", label: "Claude Desktop" },
            ]}
          />
          <TabPanel value={client} idPrefix="mcp-client" className="space-y-2 rounded-lg">
            <p className={FIELD_HINT_TEXT}>{t(`${client}Hint`)}</p>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-surface-muted p-3.5">
              <pre dir="ltr" translate="no" className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-foreground">
                {config}
              </pre>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => copy(config, t("configCopied"))}>
                <Copy aria-hidden="true" /> {tc("copy")}
              </Button>
            </div>
          </TabPanel>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="min-w-0">
            <CardTitle>{t("toolsTitle")}</CardTitle>
            <CardDescription>{t("toolsHint")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {TOOLS.map((name) => (
              <li key={name} className="grid gap-1 py-2.5 first:pt-0 last:pb-0 md:grid-cols-[14rem_minmax(0,1fr)] md:gap-4">
                <code translate="no" className="font-mono text-xs font-semibold text-foreground">{name}</code>
                <span className="text-sm text-muted-foreground">{t(`tool_${name}`)}</span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Dialog
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        size="sm"
        initialFocus="dialog"
        tone="danger"
        title={confirm === "revoke" ? t("revokeTitle") : t("reissueTitle")}
        description={confirm === "revoke" ? t("revokeDescription") : t("reissueDescription")}
        footer={
          <>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>{tc("cancel")}</Button>
            <Button variant="destructive" onClick={confirm === "revoke" ? revoke : issue} disabled={busy}>
              {busy ? tc("loading") : confirm === "revoke" ? t("revoke") : t("reissue")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted-foreground">{t("confirmNote")}</p>
      </Dialog>
    </div>
  );
}
