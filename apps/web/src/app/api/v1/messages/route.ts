import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { resolveProjectPrivileged } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
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
});

/**
 * 푸시 전송 — 수집 즉시 큐잉(로그 생성 후 즉시 ack). 실제 fan-out 은 worker 담당.
 * (수집 ≠ 전송 분리 원칙: API 는 전송에 블로킹하지 않음)
 */
export async function POST(req: Request) {
  const project = await resolveProjectPrivileged(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  if (b.type !== "broadcast" && !b.target) {
    return fail("target is required unless type=broadcast", 422);
  }

  let scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
  let isScheduled = !!scheduledAt && scheduledAt.getTime() > Date.now();

  // 방해금지 시간대 — 명시 scheduled_at 이 전혀 없을 때만 적용(명시 예약 존중)
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
      scheduledAt,
      status: isScheduled ? "scheduled" : "queued",
    })
    .returning();

  return ok({ message: rows[0] }, { scheduled: isScheduled }, 202);
}
