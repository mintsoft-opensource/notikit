"use client";

import * as React from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AdminApiError, adminApi, useAdminErrorText } from "@/lib/admin-client";

/** 취소 시점까지 실제로 나간 수 — 서버 `cancelDto` 의 `sent` 와 같은 모양 */
export type SentSoFar = { total: number; success: number; failure: number; holdout: number };

export type CanceledLog = {
  id: string;
  status: string;
  canceled_at: string | null;
  canceled_by: string | null;
  sent: SentSoFar;
};

/** 취소할 수 있는 상태 — 서버 `CANCELABLE_STATUSES` 와 같다. 끝난 발송은 되돌릴 게 없다. */
const CANCELABLE = new Set(["queued", "scheduled", "processing"]);

export function isCancelable(status: string): boolean {
  return CANCELABLE.has(status);
}

type Target = { id: string; title: string };

/**
 * 발송 취소 — 확인 → 요청 → **이미 나간 수를 알린다**.
 *
 * "취소됨" 만 보여 주면 운영자는 아무에게도 안 갔다고 읽는다. 대형 발송은 취소 버튼을 누르는
 * 순간 이미 수만 건이 나간 뒤일 수 있으므로, 성공 알림에 그 수를 함께 담는다.
 *
 * 확인은 네이티브 `confirm()` 이 아니라 콘솔 다이얼로그로 받는다 — confirm 은 버튼 글자가
 * 브라우저 언어라 한국어 화면에 "OK/Cancel" 이 섞이고 포커스 복원을 우리가 못 한다.
 */
export function useCancelSend(projectId: string, onCanceled?: (log: CanceledLog) => void) {
  const t = useTranslations("logs");
  const errorText = useAdminErrorText();
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);

  const [target, setTarget] = React.useState<Target | null>(null);
  const [busy, setBusy] = React.useState(false);

  const confirm = React.useCallback(async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      const d = await adminApi<{ log: CanceledLog }>(
        `/api/admin/projects/${projectId}/logs/${target.id}/cancel`,
        { method: "POST", body: "{}" }
      );
      setTarget(null);
      // 취소 사실과 **이미 나간 수**를 한 번에 — 둘을 떼어 놓으면 뒤의 수는 아무도 안 본다
      toast.success(t("canceled"), {
        description: t("canceledSent", {
          success: nf.format(d.log.sent.success),
          total: nf.format(d.log.sent.total),
          failure: nf.format(d.log.sent.failure),
          holdout: nf.format(d.log.sent.holdout),
        }),
      });
      onCanceled?.(d.log);
    } catch (e) {
      // 409 는 "실패" 가 아니라 "이미 끝났다" 다 — 같은 말로 뭉뚱그리면 다시 눌러 보게 된다
      const conflict = e instanceof AdminApiError && e.status === 409;
      toast.error(conflict ? t("cancelConflict") : errorText(e, t("cancelFailed")));
      if (conflict) setTarget(null);
    } finally {
      setBusy(false);
    }
  }, [target, busy, projectId, t, nf, onCanceled, errorText]);

  return { target, ask: setTarget, confirm, busy, close: () => !busy && setTarget(null) };
}

export function CancelSendDialog({
  target,
  busy,
  onConfirm,
  onClose,
}: {
  target: Target | null;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("logs");
  const tc = useTranslations("common");
  return (
    <Dialog
      open={target !== null}
      onClose={onClose}
      size="sm"
      // 읽고 결정하는 창이다 — 첫 포커스를 버튼에 두면 그 위의 경고를 통째로 건너뛴다
      initialFocus="dialog"
      title={t("cancelTitle")}
      description={target ? t("cancelDescription", { title: target.title }) : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>{tc("cancel")}</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            <Ban aria-hidden="true" className="size-4" />
            {busy ? tc("loading") : t("cancelConfirm")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted-foreground">{t("cancelDetail")}</p>
    </Dialog>
  );
}
