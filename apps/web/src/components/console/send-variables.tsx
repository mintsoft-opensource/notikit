"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Braces } from "lucide-react";
import { adminApi } from "@/lib/admin-client";

type UserAttrs = { attributes: Record<string, unknown> | null };

/** 치환에 쓸 만한 속성 이름 — 최근 사용자들의 attributes 키를 모은다. 속성 목록을 따로 관리하지 않으므로 표본이다. */
export function useAttributeKeys(projectId: string): string[] {
  const [keys, setKeys] = React.useState<string[]>([]);
  React.useEffect(() => {
    let alive = true;
    adminApi<{ users: UserAttrs[] }>(`/api/admin/projects/${projectId}/audience/users`)
      .then((d) => {
        if (!alive) return;
        const set = new Set<string>();
        for (const u of d.users) for (const [k, v] of Object.entries(u.attributes ?? {})) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") set.add(k);
        }
        setKeys([...set].sort());
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);
  return keys;
}

/** 누르면 `{{key}}` 를 마지막으로 편집한 칸의 커서 위치에 넣는다 */
export function SendVariables({ keys, onInsert }: { keys: string[]; onInsert: (token: string) => void }) {
  const t = useTranslations("send");
  const all = ["external_id", ...keys.filter((k) => k !== "external_id")];

  return (
    <div className="space-y-1.5">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Braces aria-hidden="true" className="h-3.5 w-3.5" /> {t("variables")}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {all.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => onInsert(`{{${k}}}`)}
            className="rounded-md border border-border bg-surface px-2 py-0.5 font-mono text-xs hover:border-primary/50 hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            {`{{${k}}}`}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t("variablesHint", { example: `{{name|${t("fallbackSample")}}}` })}
      </p>
    </div>
  );
}
