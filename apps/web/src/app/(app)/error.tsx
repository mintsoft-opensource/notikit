"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * 앱 셸 안의 페이지 오류 경계.
 *
 * `(app)/layout.tsx` 아래에 있으므로 페이지가 렌더 중 던져도 사이드바·헤더는 남는다 —
 * 운영자가 다른 메뉴로 빠져나가거나 이 자리에서 다시 시도할 수 있다.
 * 레이아웃 자체의 예외는 이 경계가 받지 못한다(범위 밖).
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations("common");

  React.useEffect(() => {
    // 화면에는 원문을 내지 않는다(내부 정보 노출). 브라우저 콘솔에만 남겨 신고 시 digest 로 서버 로그와 잇는다.
    console.error(error);
  }, [error]);

  return (
    <div role="alert" className="flex flex-1 items-center justify-center border border-border bg-surface shadow-card">
      <EmptyState
        icon={AlertTriangle}
        title={t("errorTitle")}
        description={error.digest ? `${t("errorDesc")} (${error.digest})` : t("errorDesc")}
        action={
          <Button variant="outline" onClick={reset}>
            <RotateCw aria-hidden="true" /> {t("retry")}
          </Button>
        }
      />
    </div>
  );
}
