import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, subscriptions, topics } from "@/db/schema";
import { verifyIdentity } from "@/lib/keys";
import { z } from "zod";

type Db = ReturnType<typeof getDb>;

export type TopicRule = { attribute: string; value: string };

/** 규칙 하나 = `attribute`/`value` 두 칸. 값은 문자열 동등 비교만 한다. */
export const ruleSchema = z.object({
  attribute: z.string().min(1).max(64),
  value: z.string().max(255),
});

/**
 * 규칙식 그룹의 규칙 목록.
 *
 * `min(1)` 인 이유: 규칙 0개는 조건이 없다는 뜻이라 "전원"이 된다. 토픽을
 * 만들었는데 전체 발송이 되는 건 사고다. 전체 발송은 broadcast 로 따로 있다.
 */
export const rulesSchema = z.array(ruleSchema).min(1).max(20);

/** 속성 규칙(AND) → SQL 조건. attribute/value 는 바인드 파라미터라 주입되지 않는다. */
export function attrConds(rules: TopicRule[]): SQL[] {
  return rules.map((r) => sql`${pushUsers.attributes} ->> ${r.attribute} = ${r.value}`);
}

/** 규칙식 그룹인가 — 빈 배열은 규칙식으로 치지 않는다(위 min(1) 과 같은 이유). */
export function isRuleFilled(rules: TopicRule[] | null): rules is TopicRule[] {
  return Boolean(rules && rules.length > 0);
}

/**
 * 토픽 규모 — 구독식은 subscriptions 를, 규칙식은 유저 속성을 센다.
 * 두 방식 모두 `is_active` 기준을 맞춰야 목록·상세·삭제 경고가 같은 수를 말한다.
 */
export async function countTopicAudience(
  db: Db,
  projectId: string,
  topic: { id: string; rules: TopicRule[] | null }
): Promise<{ devices: number; users: number }> {
  const base = [eq(devices.projectId, projectId), eq(devices.isActive, true)];

  const rows = isRuleFilled(topic.rules)
    ? await db
        .select({ userId: devices.userId })
        .from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(...base, ...attrConds(topic.rules)))
    : await db
        .select({ userId: devices.userId })
        .from(subscriptions)
        .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
        .where(and(eq(subscriptions.topicId, topic.id), ...base));

  const users = new Set<string>();
  for (const r of rows) if (r.userId) users.add(r.userId);
  return { devices: rows.length, users: users.size };
}

/**
 * 구독/해지 대상 지정 — 토큰(기기 하나) 또는 external_id(그 사람의 기기 전부).
 *
 * external_id 를 받는 이유: "이 사람을 VIP 그룹에 넣어줘"가 고객사 서버가 실제로
 * 하고 싶은 일인데, 토큰만 받으면 고객사가 기기 목록을 직접 관리해야 한다.
 */
export const targetSchema = z
  .object({
    topic: z.string().min(1).max(255),
    token: z.string().min(1).max(4096).optional(),
    external_id: z.string().min(1).max(255).optional(),
    identity_hash: z.string().max(128).optional(),
  })
  .refine((b) => Boolean(b.token) !== Boolean(b.external_id), {
    message: "provide exactly one of token or external_id",
  });

export type TargetInput = z.infer<typeof targetSchema>;

export type ResolveFailure = { error: string; status: number };
export type ResolveSuccess = { deviceIds: string[] };

/**
 * external_id 대상은 그 사람의 기기 전부를 넣고 빼는 동작이다. 공개 api-key 는 SDK 에
 * 실려 나가 비밀이 아니므로, suppressions·inbox 와 같이 프로젝트 플래그와 무관하게
 * 항상 identity_hash 를 요구한다. token 대상은 실제 기기 토큰을 알아야 하므로 그대로 둔다.
 */
export function verifyTarget(b: TargetInput, apiSecretEnc: string): ResolveFailure | null {
  if (!b.external_id) return null;
  if (b.identity_hash && verifyIdentity(b.external_id, b.identity_hash, apiSecretEnc)) return null;
  return { error: "identity_hash invalid or missing for external_id", status: 403 };
}

export function isFailure<T extends object>(r: T | ResolveFailure): r is ResolveFailure {
  return "error" in r;
}

/** 대상 기기 id 목록. external_id 는 **활성 기기만** 고른다(죽은 기기를 그룹에 남기지 않는다). */
export async function resolveDevices(
  db: Db,
  projectId: string,
  b: TargetInput
): Promise<ResolveSuccess | ResolveFailure> {
  if (b.token) {
    const d = (
      await db
        .select({ id: devices.id })
        .from(devices)
        .where(and(eq(devices.projectId, projectId), eq(devices.token, b.token)))
        .limit(1)
    )[0];
    if (!d) return { error: "Device not found — register it first", status: 404 };
    return { deviceIds: [d.id] };
  }

  const user = (
    await db
      .select({ id: pushUsers.id })
      .from(pushUsers)
      .where(and(eq(pushUsers.projectId, projectId), eq(pushUsers.externalId, b.external_id!)))
      .limit(1)
  )[0];
  if (!user) return { error: "User not found — call /v1/users/identify first", status: 404 };

  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.projectId, projectId), eq(devices.userId, user.id), eq(devices.isActive, true)));
  return { deviceIds: rows.map((r) => r.id) };
}

const RULE_FILLED: ResolveFailure = {
  error: "Topic is rule-filled — membership is computed, not subscribed",
  status: 409,
};

/**
 * 토픽 조회. `create` 면 없을 때 만든다(구독은 자동 생성, 해지는 아니다).
 *
 * 규칙식 그룹은 명단을 저장하지 않으므로 손으로 넣고 뺄 수 없다. 허용하면 규칙과
 * 수동 명단이 공존하면서 "왜 이 사람이 안 받았지"를 설명할 수 없게 된다.
 */
export async function resolveWritableTopic(
  db: Db,
  projectId: string,
  name: string,
  create: boolean
): Promise<{ topicId: string } | ResolveFailure> {
  const existing = (
    await db
      .select({ id: topics.id, rules: topics.rules })
      .from(topics)
      .where(and(eq(topics.projectId, projectId), eq(topics.name, name)))
      .limit(1)
  )[0];

  if (existing) {
    if (isRuleFilled(existing.rules)) return RULE_FILLED;
    return { topicId: existing.id };
  }

  if (!create) return { error: "Topic not found", status: 404 };

  // 조회와 insert 사이에 같은 이름의 규칙식 토픽이 생겼을 수 있다. 충돌 시 기존 행이
  // 돌아오므로 여기서 한 번 더 확인한다.
  const created = (
    await db
      .insert(topics)
      .values({ projectId, name })
      .onConflictDoUpdate({ target: [topics.projectId, topics.name], set: { name } })
      .returning({ id: topics.id, rules: topics.rules })
  )[0];
  if (isRuleFilled(created.rules)) return RULE_FILLED;
  return { topicId: created.id };
}

export async function subscribeDevices(db: Db, topicId: string, deviceIds: string[]): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const rows = await db
    .insert(subscriptions)
    .values(deviceIds.map((deviceId) => ({ topicId, deviceId })))
    .onConflictDoNothing({ target: [subscriptions.topicId, subscriptions.deviceId] })
    .returning({ id: subscriptions.id });
  return rows.length;
}

export async function unsubscribeDevices(db: Db, topicId: string, deviceIds: string[]): Promise<number> {
  if (deviceIds.length === 0) return 0;
  const rows = await db
    .delete(subscriptions)
    .where(and(eq(subscriptions.topicId, topicId), inArray(subscriptions.deviceId, deviceIds)))
    .returning({ id: subscriptions.id });
  return rows.length;
}
