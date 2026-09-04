import { getDb } from "@/db/client";
import { pushLogs } from "@/db/schema";
import { resolveProjectPrivileged } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().min(1).max(255),
  body: z.string().min(1).max(4000),
  type: z.enum(["single", "broadcast", "topic"]),
  target: z.string().max(255).optional(),
  deep_link: z.string().url().max(2048).optional(),
  data: z
    .record(z.unknown())
    .optional()
    .refine((d) => !d || Buffer.byteLength(JSON.stringify(d), "utf8") <= 8192, "data too large (max 8KB)"),
});

/**
 * 푸시 전송 — 수집 즉시 큐잉(로그 생성 후 즉시 ack). 실제 fan-out 은 worker 담당.
 * (수집 ≠ 전송 분리 원칙: API 는 전송에 블로킹하지 않음)
 */
export async function POST(req: Request) {
  const project = await resolveProjectPrivileged(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(req, project.id))) return fail("Rate limit exceeded", 429);

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
      status: "queued",
    })
    .returning();

  // TODO(worker): enqueue fan-out job (BullMQ) — 현재는 큐 레코드만 생성
  return ok({ message: rows[0] }, { queued: true }, 202);
}
