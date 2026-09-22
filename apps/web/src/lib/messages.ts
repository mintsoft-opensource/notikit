import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { z } from "zod";

/** 다중 발송 한 건의 최대 인원 — 이보다 많으면 토픽으로 묶는 게 맞다 */
export const MAX_MULTI_TARGETS = 1000;

/** 발송 요청 본문 상한 — 기본 32KB 로는 다중 발송 1000명 목록이 들어가지 않는다 */
export const MESSAGE_BODY_LIMIT = 96 * 1024;

/** 푸시 발송 입력 스키마 (App SDK /v1/messages 와 Web Admin 발송이 공유) */
export const messageSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4000),
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

/** 타입별 대상 필드 검사 — 콘솔(admin)과 SDK(v1) 발송이 같은 규칙을 쓴다. null 이면 통과. */
export function targetError(b: MessageInput): string | null {
  if (b.type === "multi") return b.targets?.length ? null : "targets is required for type=multi";
  if (b.type !== "broadcast" && !b.target) return "target is required unless type=broadcast";
  return null;
}

export type EnqueueProject = { id: string; quietStartHour: number | null; quietEndHour: number | null };

/**
 * 발송 큐잉 — 로그(push_logs) 레코드 생성 후 즉시 ack. 실제 fan-out 은 worker.
 * 명시 scheduled_at 이 없으면 프로젝트 방해금지 시간대 규칙 적용.
 */
export async function enqueuePush(project: EnqueueProject, b: MessageInput) {
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
