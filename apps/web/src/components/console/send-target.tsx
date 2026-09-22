"use client";

import * as React from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { Megaphone, Radio } from "lucide-react";
import { Select, Field } from "@/components/ui/input";
import { adminApi } from "@/lib/admin-client";
import { SendUserPicker, type PickedUser } from "@/components/console/send-user-picker";

export type SendType = "single" | "multi" | "broadcast" | "topic";

type TopicOption = { id: string; name: string; rules: unknown[] | null; userCount: number; deviceCount: number };

/**
 * "받는 사람" 영역. 발송 방식마다 모양이 다르다 — 개별·다중은 사용자 검색 팝업,
 * 토픽은 이미 있는 토픽 중에서 고르기, 전체는 입력 없이 범위만 알린다.
 */
export function SendTarget({
  projectId,
  type,
  target,
  onTarget,
  users,
  onUsers,
}: {
  projectId: string;
  type: SendType;
  target: string;
  onTarget: (v: string) => void;
  users: PickedUser[];
  onUsers: (u: PickedUser[]) => void;
}) {
  const t = useTranslations("send");

  if (type === "single" || type === "multi") {
    return <SendUserPicker projectId={projectId} multiple={type === "multi"} value={users} onChange={onUsers} />;
  }

  if (type === "topic") return <TopicTarget projectId={projectId} target={target} onTarget={onTarget} />;

  return (
    <div className="flex items-start gap-3 rounded-tile border border-border bg-accent-soft px-3.5 py-3 text-sm">
      <Megaphone aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <p className="leading-relaxed">{t("broadcastNotice")}</p>
    </div>
  );
}

function TopicTarget({ projectId, target, onTarget }: { projectId: string; target: string; onTarget: (v: string) => void }) {
  const t = useTranslations("send");
  const ta = useTranslations("audience");
  const locale = useLocale();
  const nf = React.useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [topics, setTopics] = React.useState<TopicOption[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    adminApi<{ topics: TopicOption[] }>(`/api/admin/projects/${projectId}/audience/topics`)
      .then((d) => alive && setTopics(d.topics))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [projectId]);

  // 링크로 받은 토픽이 목록에 없더라도(방금 지워졌거나 오타) 선택값을 조용히 바꾸지 않는다
  const selected = topics?.find((tp) => tp.name === target) ?? null;

  if (topics && topics.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-tile border border-dashed border-border px-3.5 py-3 text-sm">
        <span className="text-muted-foreground">{t("noTopics")}</span>
        <Link href={`/projects/${projectId}/topics`} className="shrink-0 font-semibold text-primary hover:underline">
          {t("manageTopics")}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Field label={t("targetTopic")} hint={failed ? t("topicsLoadFailed") : undefined}>
        <Select value={target} onChange={(e) => onTarget(e.target.value)} disabled={!topics && !failed}>
          <option value="">{t("targetTopicPlaceholder")}</option>
          {target && !selected && <option value={target}>{target}</option>}
          {topics?.map((tp) => (
            <option key={tp.id} value={tp.name}>
              {tp.name} · {ta(tp.rules?.length ? "kindRules" : "kindSubscribe")}
            </option>
          ))}
        </Select>
      </Field>
      {selected && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Radio aria-hidden="true" className="h-3.5 w-3.5" />
          {t("audienceTopic", { users: nf.format(selected.userCount), devices: nf.format(selected.deviceCount) })}
        </p>
      )}
    </div>
  );
}
