import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, subscriptions, topics } from "@/db/schema";
import { verifyIdentity } from "@/lib/keys";
import { z } from "zod";
import { notSuppressed } from "@/lib/audience-count";
import { RULE_OPS, isNumericOp, isNumericValue, type RuleOp } from "@/lib/topic-rule-ops";

export { RULE_OPS, NUMERIC_OPS, isNumericOp, isNumericValue, type RuleOp } from "@/lib/topic-rule-ops";

type Db = ReturnType<typeof getDb>;

/** `op` 가 없으면 eq — 연산자 도입 전에 저장된 규칙이 그대로 동작한다. */
export type TopicRule = { attribute: string; op?: RuleOp; value: string };

/** SQL 쪽에서 캐스트 전에 거는 정규식 — isNumericValue 와 같은 모양. 숫자가 아닌 속성값은 캐스트하지 않는다 */
const NUMERIC_SQL_RE = "^-?[0-9]+(\\.[0-9]+)?$";

/** 규칙 하나 = 속성·연산자·값. 크기 비교 연산자는 값이 숫자여야 한다. */
export const ruleSchema = z
  .object({
    attribute: z.string().min(1).max(64),
    op: z.enum(RULE_OPS).optional(),
    value: z.string().max(255),
  })
  .refine((r) => !isNumericOp(r.op) || isNumericValue(r.value), {
    message: "value must be a number for gt/gte/lt/lte",
    path: ["value"],
  });

/**
 * 규칙식 그룹의 규칙 목록.
 *
 * `min(1)` 인 이유: 규칙 0개는 조건이 없다는 뜻이라 "전원"이 된다. 토픽을
 * 만들었는데 전체 발송이 되는 건 사고다. 전체 발송은 broadcast 로 따로 있다.
 */
export const rulesSchema = z.array(ruleSchema).min(1).max(20);

function numericCompare(attr: SQL, op: RuleOp, value: string): SQL {
  // 숫자 모양일 때만 캐스트한다 — "abc" 같은 값은 비교 대상에서 빠지고 SQL 오류가 나지 않는다
  const num = sql`(CASE WHEN ${attr} ~ ${NUMERIC_SQL_RE} THEN (${attr})::numeric END)`;
  const rhs = sql`${value.trim()}::numeric`;
  if (op === "gt") return sql`${num} > ${rhs}`;
  if (op === "gte") return sql`${num} >= ${rhs}`;
  if (op === "lt") return sql`${num} < ${rhs}`;
  return sql`${num} <= ${rhs}`;
}

/** 규칙 하나 → SQL 조건. 속성명·값은 모두 바인드 파라미터라 주입되지 않는다. */
export function ruleCond(r: TopicRule): SQL {
  const attr = sql`(${pushUsers.attributes} ->> ${r.attribute})`;
  const op = r.op ?? "eq";
  if (op === "eq") return sql`${attr} = ${r.value}`;
  // 속성이 없는 유저는 neq 에도 맞지 않는다 — 대상이 의도보다 넓어지지 않게
  if (op === "neq") return sql`${attr} <> ${r.value}`;
  if (op === "contains") return sql`strpos(lower(${attr}), lower(${r.value})) > 0`;
  // 저장 경로는 zod 가 막지만, 오래된 행이나 우회 입력이 와도 오류 대신 "아무도 안 맞음"
  if (!isNumericValue(r.value)) return sql`false`;
  return numericCompare(attr, op, r.value);
}

/** 속성 규칙(AND) → SQL 조건 목록. 발송·도달 인원·클릭 자격이 모두 이 함수를 쓴다. */
export function attrConds(rules: TopicRule[]): SQL[] {
  return rules.map(ruleCond);
}

/** 규칙식 그룹인가 — 빈 배열은 규칙식으로 치지 않는다(위 min(1) 과 같은 이유). */
export function isRuleFilled(rules: TopicRule[] | null): rules is TopicRule[] {
  return Boolean(rules && rules.length > 0);
}

/**
 * 토픽 규모 — 구독식은 subscriptions 를, 규칙식은 유저 속성을 센다.
 * 발송 대상과 같은 기준(활성·비억제)을 써야 목록·상세·삭제 경고가 발송 추정과 같은 수를 말한다.
 * 행을 가져오지 않고 SQL 집계 한 번으로 센다.
 */
export async function countTopicAudience(
  db: Db,
  projectId: string,
  topic: { id: string; rules: TopicRule[] | null }
): Promise<{ devices: number; users: number }> {
  const base = [eq(devices.projectId, projectId), eq(devices.isActive, true), notSuppressed(projectId)];
  const fields = {
    devices: sql<number>`count(*)::int`,
    users: sql<number>`count(distinct ${devices.userId})::int`,
  };

  const row = isRuleFilled(topic.rules)
    ? (
        await db
          .select(fields)
          .from(devices)
          .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
          .where(and(...base, ...attrConds(topic.rules)))
      )[0]
    : (
        await db
          .select(fields)
          .from(subscriptions)
          .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
          .where(and(eq(subscriptions.topicId, topic.id), ...base))
      )[0];

  return { devices: Number(row?.devices) || 0, users: Number(row?.users) || 0 };
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
    message: "provide exactly one of token or user_id",
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
  return { error: "identity_hash invalid or missing for user_id", status: 403 };
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
