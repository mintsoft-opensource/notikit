import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { verifyIdentity } from "@/lib/keys";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { recordReinstall } from "@/lib/device-events";
import { recordAccess } from "@/lib/device-activity";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(["android", "ios", "web", "webview", "electron", "flutter", "react-native"]),
  // null = 명시적 언바인딩(로그아웃). 생략과 구분된다: 생략은 기존 바인딩 유지.
  external_id: z.string().max(255).nullable().optional(),
  identity_hash: z.string().max(128).optional(),
  app_version: z.string().max(64).optional(),
  os_version: z.string().max(64).optional(),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(64).optional(),
  country: z.string().max(8).optional(),
});

/** 디바이스/토큰 등록·업서트 (public: api-key). external_id 바인딩은 identity 검증 필요. */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "devices"))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  // external_id 바인딩 시 identity 검증(HMAC) — 타 유저 사칭 방지
  if (b.external_id && project.requireIdentityVerification) {
    if (!b.identity_hash || !verifyIdentity(b.external_id, b.identity_hash, project.apiSecretEnc)) {
      return fail("identity_hash invalid or missing for external_id binding", 403);
    }
  }

  const db = getDb();

  // 로그아웃/계정전환: external_id: null 이면 바인딩 해제. 없으면 이후 클릭이 이전 계정에 계속 귀속된다.
  const unbind = b.external_id === null;

  // 해제도 바인딩과 같은 증명을 요구한다. 검사가 없으면 공개 api-key 와 남의 토큰만으로
  // 그 기기의 바인딩을 끊어 유저 타겟 발송에서 제외시킬 수 있다.
  if (unbind && project.requireIdentityVerification) {
    const bound = (
      await db
        .select({ externalId: pushUsers.externalId })
        .from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
        .limit(1)
    )[0];
    // 이미 바인딩이 없으면 해제는 무의미하므로 그대로 통과(멱등)
    if (bound) {
      if (!b.identity_hash || !verifyIdentity(bound.externalId, b.identity_hash, project.apiSecretEnc)) {
        return fail("identity_hash invalid or missing for unbind", 403);
      }
    }
  }

  // 업서트 전 상태 — 비활성이던 기기가 다시 등록되면 재설치로 남긴다
  const before = (
    await db
      .select({ id: devices.id, isActive: devices.isActive })
      .from(devices)
      .where(and(eq(devices.projectId, project.id), eq(devices.token, b.token)))
      .limit(1)
  )[0];

  let userId: string | null = null;
  if (b.external_id) {
    const u = await db
      .insert(pushUsers)
      .values({ projectId: project.id, externalId: b.external_id, locale: b.locale, timezone: b.timezone })
      .onConflictDoUpdate({
        target: [pushUsers.projectId, pushUsers.externalId],
        // externalId 항상 포함 → set 이 비지 않음(drizzle "No values to set" 방지)
        set: { externalId: b.external_id, locale: b.locale, timezone: b.timezone },
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
        ...(b.external_id || unbind ? { userId } : {}),
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

  const device = rows[0];
  // 등록도 접속이다 — 첫 실행 직후의 활동이 통계에서 빠지지 않게.
  // 다만 언바인딩(로그아웃)은 앱을 연 것이 아니므로 opens 를 올리지 않는다.
  if (device && !unbind) await recordAccess(db, project.id, device);
  if (before && !before.isActive && device) {
    await recordReinstall(db, project.id, { id: device.id, userId: device.userId, platform: device.platform });
  }

  return ok({ device }, undefined, 201);
}
