import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { z } from "zod";

/** 푸시 발송 입력 스키마 (App SDK /v1/messages 와 Web Admin 발송이 공유) */
export const messageSchema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4000),
  type: z.enum(["single", "broadcast", "topic", "segment"]),
  target: z.string().max(255).optional(),
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
      target: b.target,
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
