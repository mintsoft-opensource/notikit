import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, subscriptions } from "@/db/schema";
import { resolveProjectPublic } from "@/lib/auth";
import { readJsonLimited, PayloadTooLargeError } from "@/lib/read-json";
import { verifyIdentity } from "@/lib/keys";
import { rateLimit, clientKey } from "@/lib/rate-limit";
import { ok, fail } from "@/lib/api-response";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.object({
  old_token: z.string().min(1).max(4096),
  new_token: z.string().min(1).max(4096),
  identity_hash: z.string().max(128).optional(),
});

/**
 * 푸시 토큰 교체 (public: api-key).
 *
 * 새 토큰으로 그냥 등록하면 **행이 하나 더 생긴다**. 옛 행은 유저 바인딩을 유지한 채
 * 활성으로 남아 같은 사람에게 두 번 발송된다(옛 토큰이 죽었다는 사실은 다음 스윕까지
 * 알 수 없다). 그래서 기존 행의 토큰을 제자리에서 갱신한다 — 기기 id 가 그대로라
 * 토픽 구독·클릭 이력·접속 통계가 전부 보존된다.
 */
export async function POST(req: Request) {
  const project = await resolveProjectPublic(req);
  if (!project) return fail("Unauthorized", 401);
  if (!rateLimit(clientKey(project.id, "rotate"))) return fail("Rate limit exceeded", 429);

  let payload: unknown;
  try {
    payload = await readJsonLimited(req);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? fail("Payload too large", 413) : fail("Invalid JSON", 400);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Invalid body", 422);
  const b = parsed.data;

  if (b.old_token === b.new_token) return ok({ rotated: false, reason: "same token" }, undefined, 202);

  const db = getDb();

  // 인가 검사와 갱신을 한 트랜잭션에 묶고 대상 행을 잠근다.
  // 나눠 두면 (a) 검사 후 갱신 전에 다른 계정이 이 기기를 바인딩하면 검사에 쓰인
  // 바인딩이 낡아 남의 알림을 가져갈 수 있고, (b) 그 사이 new_token 이 등록되면
  // 갱신이 유니크 제약을 위반해 500 으로 터진다.
  return await db.transaction(async (tx) => {
    const current = (
      await tx
        .select({ id: devices.id, userId: devices.userId, externalId: pushUsers.externalId })
        .from(devices)
        .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(eq(devices.projectId, project.id), eq(devices.token, b.old_token)))
        .for("update", { of: devices })
        .limit(1)
    )[0];

    // 모르는 토큰이어도 202 로 답한다 — 404 로 갈라주면 공개 api-key 만 가진 쪽이
    // 임의 토큰의 등록 여부를 확인하는 오라클이 된다(ping 과 같은 이유).
    if (!current) return ok({ rotated: false }, undefined, 202);

    // 교체는 이 기기로 갈 발송을 통째로 새 토큰으로 돌린다. 유저가 묶여 있으면
    // 바인딩과 같은 수준의 증명을 요구한다 — 없으면 옛 토큰을 아는 쪽이 남의 알림을
    // 자기 토큰으로 가져갈 수 있다(언바인딩과 동일한 방어).
    if (current.externalId && project.requireIdentityVerification) {
      if (!b.identity_hash || !verifyIdentity(current.externalId, b.identity_hash, project.apiSecretEnc)) {
        return fail("identity_hash invalid or missing for token rotation", 403);
      }
    }

    // 새 토큰이 이미 다른 행으로 등록돼 있으면 제자리 갱신이 유니크 제약에 걸린다.
    // 그 행이 이 기기의 현재 등록이므로, 옛 행의 유저 바인딩과 토픽 구독을 그쪽으로
    // 옮긴 뒤 옛 행을 접는다. 그냥 비활성만 시키면 바인딩·구독이 죽은 행에 남아
    // 유저·토픽 타겟 발송에서 이 기기가 통째로 빠진다.
    const conflict = (
      await tx
        .select({ id: devices.id, userId: devices.userId })
        .from(devices)
        .where(and(eq(devices.projectId, project.id), eq(devices.token, b.new_token)))
        .for("update", { of: devices })
        .limit(1)
    )[0];

    if (conflict && conflict.id !== current.id) {
      if (current.userId && !conflict.userId) {
        await tx.update(devices).set({ userId: current.userId }).where(eq(devices.id, conflict.id));
      }
      // 구독 이관 — 새 행에 이미 있는 토픽은 유니크 충돌이므로 건너뛴다
      const subs = await tx
        .select({ topicId: subscriptions.topicId })
        .from(subscriptions)
        .where(eq(subscriptions.deviceId, current.id));
      if (subs.length) {
        await tx
          .insert(subscriptions)
          .values(subs.map((s) => ({ topicId: s.topicId, deviceId: conflict.id })))
          .onConflictDoNothing({ target: [subscriptions.topicId, subscriptions.deviceId] });
      }
      await tx.update(devices).set({ isActive: false }).where(eq(devices.id, current.id));
      // 이관했으므로 호출부 입장에서는 교체가 완료된 것과 같다. 응답을 갈라주면
      // 공개 api-key 만으로 임의 토큰의 등록 여부를 알아내는 오라클이 된다.
      return ok({ rotated: true, device_id: conflict.id }, undefined, 202);
    }

    await tx
      .update(devices)
      .set({
        token: b.new_token,
        isActive: true,
        lastActiveAt: new Date(),
        // 새 토큰은 아직 FCM 이 받아준 적이 없다 — 검증 표시를 물려주면 안 된다
        verifiedAt: null,
      })
      .where(eq(devices.id, current.id));

    return ok({ rotated: true, device_id: current.id }, undefined, 202);
  });
}
