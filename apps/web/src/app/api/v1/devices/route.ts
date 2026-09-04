import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers } from "@/db/schema";
import { resolveProject } from "@/lib/auth";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(1),
  platform: z.enum(["android", "ios", "web", "webview", "electron", "flutter", "react-native"]),
  external_id: z.string().optional(),
  app_version: z.string().optional(),
  os_version: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  country: z.string().optional(),
});

/** 디바이스/토큰 등록·업서트 (+ external_id 있으면 유저 연결) */
export async function POST(req: Request) {
  const project = await resolveProject(req);
  if (!project) return fail("Unauthorized", 401);

  const parsed = schema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  const db = getDb();

  let userId: string | null = null;
  if (b.external_id) {
    const u = await db
      .insert(pushUsers)
      .values({ projectId: project.id, externalId: b.external_id, locale: b.locale, timezone: b.timezone })
      .onConflictDoUpdate({
        target: [pushUsers.projectId, pushUsers.externalId],
        set: { locale: b.locale, timezone: b.timezone },
      })
      .returning();
    userId = u[0]?.id ?? null;
  }

  const rows = await db
    .insert(devices)
    .values({
      projectId: project.id,
      token: b.token,
      platform: b.platform,
      userId,
      appVersion: b.app_version,
      osVersion: b.os_version,
      locale: b.locale,
      timezone: b.timezone,
      country: b.country,
      isActive: true,
      lastActiveAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [devices.projectId, devices.token],
      set: {
        platform: b.platform,
        userId,
        appVersion: b.app_version,
        osVersion: b.os_version,
        locale: b.locale,
        timezone: b.timezone,
        country: b.country,
        isActive: true,
        lastActiveAt: new Date(),
      },
    })
    .returning();

  return ok({ device: rows[0] }, undefined, 201);
}
