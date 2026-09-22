import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messageTemplates, pushLogs } from "@/db/schema";
import { applyTemplate, MAX_TEMPLATE_FIELDS } from "@/lib/templates";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { z } from "zod";

/** 다중 발송 한 건의 최대 인원 — 이보다 많으면 토픽으로 묶는 게 맞다 */
export const MAX_MULTI_TARGETS = 1000;

/** 발송 요청 본문 상한 — 기본 32KB 로는 다중 발송 1000명 목록이 들어가지 않는다 */
export const MESSAGE_BODY_LIMIT = 96 * 1024;

/** 푸시 발송 입력 스키마 (App SDK /v1/messages 와 Web Admin 발송이 공유) */
export const messageSchema = z.object({
  // 템플릿을 쓰면 비워도 된다 — prepareMessage 가 채운 뒤 비어 있으면 거절한다
  title: z.string().max(255).optional(),
  body: z.string().max(4000).optional(),
  /** 콘솔에서 만든 메시지 템플릿 이름. 제목·본문·딥링크·커스텀 필드를 채운다. */
  template: z.string().trim().min(1).max(120).optional(),
  /** 템플릿이 정의한 커스텀 필드 값 → 푸시 data */
  fields: z
    .record(z.string().max(500))
    .optional()
    .refine((f) => !f || Object.keys(f).length <= MAX_TEMPLATE_FIELDS, `at most ${MAX_TEMPLATE_FIELDS} fields`),
  type: z.enum(["single", "multi", "broadcast", "topic", "segment"]),
  target: z.string().max(255).optional(),
  /** type=multi 의 받는 사람. 중복은 서버에서 합친다. */
  targets: z.array(z.string().min(1).max(255)).min(1).max(MAX_MULTI_TARGETS).optional(),
  scheduled_at: z.string().datetime().optional(),
  deep_link: z.string().url().max(2048).optional(),
  data: z
    .record(z.unknown())
    .optional()
    .refine((d) => !d || Buffer.byteLength(JSON.stringify(d), "utf8") <= 8192, "data too large (max 8KB)"),
  variants: z
    .array(z.object({ title: z.string().min(1).max(255), body: z.string().min(1).max(4000) }))
    .min(2)
    .max(5)
    .optional(),
  kakao_fallback: z.boolean().optional(),
});

export type MessageInput = z.infer<typeof messageSchema>;

/** 템플릿·검증을 거쳐 큐에 넣을 수 있게 된 발송 — 제목·본문이 확정돼 있다 */
export type ReadyMessage = Omit<MessageInput, "title" | "body" | "template" | "fields"> & { title: string; body: string };

const DATA_LIMIT_BYTES = 8192;

/**
 * 발송 요청 → 큐에 넣을 메시지. 콘솔(admin)과 SDK(v1)가 같은 규칙을 쓴다.
 * 대상 검사 → 템플릿 적용 → 제목·본문·data 크기 확인 순서.
 */
export async function prepareMessage(
  projectId: string,
  b: MessageInput
): Promise<{ message: ReadyMessage } | { error: string; status: number }> {
  const targetErr = targetError(b);
  if (targetErr) return { error: targetErr, status: 422 };

  const { template, fields, ...rest } = b;
  let merged: Omit<ReadyMessage, "title" | "body"> & { title?: string; body?: string } = rest;

  if (template) {
    const tpl = (
      await getDb()
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.projectId, projectId), eq(messageTemplates.name, template)))
        .limit(1)
    )[0];
    if (!tpl) return { error: `Template not found: ${template}`, status: 404 };
    const applied = applyTemplate(tpl, { title: b.title, body: b.body, deep_link: b.deep_link, data: b.data, fields });
    if ("error" in applied) return { error: applied.error, status: 422 };
    merged = { ...rest, ...applied };
  } else if (fields) {
    return { error: "fields requires template", status: 422 };
  }

  if (!merged.title || !merged.body) return { error: "title and body are required (directly or via template)", status: 422 };
  if (merged.data && Buffer.byteLength(JSON.stringify(merged.data), "utf8") > DATA_LIMIT_BYTES) {
    return { error: "data too large (max 8KB)", status: 422 };
  }
  return { message: { ...merged, title: merged.title, body: merged.body } };
}

/** 타입별 대상 필드 검사 — 콘솔(admin)과 SDK(v1) 발송이 같은 규칙을 쓴다. null 이면 통과. */
export function targetError(b: Pick<MessageInput, "type" | "target" | "targets">): string | null {
  if (b.type === "multi") return b.targets?.length ? null : "targets is required for type=multi";
  if (b.type !== "broadcast" && !b.target) return "target is required unless type=broadcast";
  return null;
}

export type EnqueueProject = { id: string; quietStartHour: number | null; quietEndHour: number | null };

/**
 * 발송 큐잉 — 로그(push_logs) 레코드 생성 후 즉시 ack. 실제 fan-out 은 worker.
 * 명시 scheduled_at 이 없으면 프로젝트 방해금지 시간대 규칙 적용.
 */
export async function enqueuePush(project: EnqueueProject, b: ReadyMessage) {
  let scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
  let isScheduled = !!scheduledAt && scheduledAt.getTime() > Date.now();

  if (!b.scheduled_at) {
    const quietEnd = nextAllowedTime(project.quietStartHour, project.quietEndHour);
    if (quietEnd) {
      scheduledAt = quietEnd;
      isScheduled = true;
    }
  }

  const db = getDb();
  const rows = await db
    .insert(pushLogs)
    .values({
      projectId: project.id,
      type: b.type,
      target: b.type === "multi" ? null : b.target,
      targets: b.type === "multi" ? [...new Set(b.targets)] : null,
      title: b.title,
      body: b.body,
      deepLink: b.deep_link,
      data: b.data,
      variants: b.variants,
      kakaoFallback: b.kakao_fallback ?? false,
      scheduledAt,
      status: isScheduled ? "scheduled" : "queued",
    })
    .returning();

  return { message: rows[0], scheduled: isScheduled };
}
