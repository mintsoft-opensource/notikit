"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { ArrowRight, Braces, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { adminApi } from "@/lib/admin-client";
import { BUILTIN_VARIABLES } from "@/lib/personalize";
import { cn } from "@/lib/utils";
import { FIELD_HINT_TEXT } from "@/components/ui/input";

type UserAttrs = { attributes: Record<string, unknown> | null };

const HOW_OPEN_KEY = "notikit.send.variablesHowOpen";

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

const isBuiltin = (k: string) => (BUILTIN_VARIABLES as readonly string[]).includes(k);

/**
 * 치환 변수 — 코드(`{{name}}`)만 보여 주면 무엇이 들어가는지 알 수 없다.
 * 변수마다 이름과 **지금 미리보기 기준의 실제 값**을 같이 보여 주고, 쓰는 법을 예시로 풀어 준다.
 * 누르면 `{{key}}` 를 마지막으로 편집한 칸의 커서 위치에 넣는다.
 */
export function SendVariables({
  keys,
  onInsert,
  render,
  basis,
  disabled,
}: {
  keys: string[];
  onInsert: (token: string) => void;
  /** 템플릿 조각을 미리보기 기준으로 치환 — 예시 값 표시용 */
  render: (template: string) => string;
  /** 예시 값의 기준(고른 사용자 이름 등). 없으면 기본값 기준 */
  basis: string | null;
  disabled?: boolean;
}) {
  const t = useTranslations("send");
  const all = [...BUILTIN_VARIABLES, ...keys.filter((k) => !isBuiltin(k))];
  const [howOpen, setHowOpen] = React.useState(true);

  // 처음에는 펼쳐 두고, 접으면 다음에도 접힌 채로 연다(익숙해진 운영자에게는 자리만 차지한다)
  React.useEffect(() => {
    try {
      if (localStorage.getItem(HOW_OPEN_KEY) === "0") setHowOpen(false);
    } catch {
      /* 저장소를 못 쓰면 펼친 채로 둔다 */
    }
  }, []);

  function toggleHow() {
    setHowOpen((v) => {
      try { localStorage.setItem(HOW_OPEN_KEY, v ? "0" : "1"); } catch { /* 무시 */ }
      return !v;
    });
  }

  const empty = t("exampleEmpty");
  const fallbackWord = t("fallbackSample");
  const attrSample = keys.find((k) => !isBuiltin(k));

  const suffix = t("howGreetingSuffix");
  // 기본값 예시는 "이름이 없을 때"를 같이 보여 줘야 뜻이 전해진다 — 고른 사람에게 이름이 있으면 기본값이 안 보이므로
  const examples: Array<{ input: string; note: string; alt?: string }> = [
    { input: `{{name}}${suffix}`, note: t("howBasic") },
    {
      input: `{{name|${fallbackWord}}}${suffix}`,
      note: t("howFallback", { fallback: fallbackWord }),
      alt: `${fallbackWord}${suffix}`,
    },
    { input: `{{${attrSample ?? "plan"}}}`, note: t("howAttribute") },
  ];

  return (
    <section aria-labelledby="send-variables-title" className="space-y-4 rounded-lg border border-border bg-surface-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 id="send-variables-title" className="flex items-center gap-1.5 text-sm font-semibold">
            <Braces aria-hidden="true" className="size-4 text-muted-foreground" /> {t("variables")}
          </h3>
          <p className={cn("mt-0.5", FIELD_HINT_TEXT)}>
            {basis ? t("variablesBasis", { who: basis }) : t("variablesBasisDefault")}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" aria-expanded={howOpen} onClick={toggleHow}>
          {t("howTitle")}
          <ChevronDown aria-hidden="true" className={cn("transition-transform", howOpen && "rotate-180")} />
        </Button>
      </div>

      {howOpen && (
        <div className="space-y-2 rounded-lg border border-border bg-surface p-3">
          <p className="text-xs leading-relaxed text-muted-foreground">{t("howIntro")}</p>
          <ul className="space-y-1.5">
            {examples.map((ex) => (
              <li key={ex.input} className="grid gap-1 text-xs sm:grid-cols-[minmax(0,14rem)_auto_minmax(0,1fr)] sm:items-center sm:gap-2">
                <code className="truncate rounded-md bg-surface-muted px-2 py-1 font-mono text-foreground">{ex.input}</code>
                <ArrowRight aria-hidden="true" className="hidden size-4 text-muted-foreground sm:block" />
                <span className="min-w-0">
                  <span className="font-semibold text-foreground">{render(ex.input) || empty}</span>
                  {ex.alt && (
                    <span className="ms-1.5 text-muted-foreground">
                      · {t("howNoName")} <span className="font-semibold text-foreground">{ex.alt}</span>
                    </span>
                  )}
                  <span className="ms-1.5 text-muted-foreground">— {ex.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 변수는 칸 밖에 따로 서 있는 버튼이라 공용 Button(36px). 이름과 예시 값을 함께 보여 준다. */}
      <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-3">
        {all.map((k) => {
          const label = isBuiltin(k) ? t(`var_${k}` as "var_name") : t("varAttribute");
          return (
            <Button
              key={k}
              type="button"
              variant="outline"
              className="h-9 min-w-0 justify-start gap-2 px-2.5 font-normal"
              disabled={disabled}
              aria-label={`{{${k}}} ${label}`}
              onClick={() => onInsert(`{{${k}}}`)}
            >
              <span className="shrink-0 font-mono text-xs text-primary">{`{{${k}}}`}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
              <span aria-hidden="true" className="ms-auto min-w-0 truncate text-xs font-semibold text-foreground">
                {render(`{{${k}}}`) || empty}
              </span>
            </Button>
          );
        })}
      </div>
    </section>
  );
}
