import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import {
  deviceActivity,
  devices,
  pushClicks,
  pushConversions,
  pushUserSends,
  pushUsers,
  subscriptions,
  topics,
} from "@/db/schema";
import { verifyIdentity } from "@/lib/keys";
import { z } from "zod";
import { notSuppressed } from "@/lib/audience-count";
import {
  BEHAVIOR_OPS,
  BEHAVIOR_SOURCES,
  MAX_BEHAVIOR_COUNT,
  MAX_BEHAVIOR_DAYS,
  RULE_OPS,
  isBehaviorRule,
  isBehaviorUsable,
  isIntInRange,
  isNumericOp,
  isNumericValue,
  needsDays,
  supportsName,
  type BehaviorRule,
  type RuleOp,
  type TopicRule,
} from "@/lib/topic-rule-ops";

export {
  RULE_OPS,
  NUMERIC_OPS,
  BEHAVIOR_OPS,
  BEHAVIOR_SOURCES,
  MAX_BEHAVIOR_DAYS,
  MAX_BEHAVIOR_COUNT,
  isNumericOp,
  isNumericValue,
  isBehaviorRule,
  type RuleOp,
  type TopicRule,
  type AttributeRule,
  type BehaviorRule,
  type BehaviorSource,
  type BehaviorOp,
} from "@/lib/topic-rule-ops";

type Db = ReturnType<typeof getDb>;

/**
 * `topics.rules` 의 jsonb $type 은 아직 속성 규칙만 알고 있다(schema.ts 는 이번 차수에
 * 다른 곳이 쥐고 있어 넓힐 수 없다). 읽기는 그대로 통하지만 — 속성 규칙은 유니온의
 * 한쪽이다 — 쓰기는 좁은 타입에 막힌다. 그 한 군데의 거짓말을 여기 모아 둔다.
 */
type StoredRules = typeof topics.$inferSelect["rules"];

export function toStoredRules(rules: TopicRule[]): StoredRules {
  return rules as StoredRules;
}

/** SQL 쪽에서 캐스트 전에 거는 정규식 — isNumericValue 와 같은 모양. 숫자가 아닌 속성값은 캐스트하지 않는다 */
const NUMERIC_SQL_RE = "^-?[0-9]+(\\.[0-9]+)?$";

const NEED_NUMBER = "value must be a number for gt/gte/lt/lte";
const NEED_DAYS = `days must be an integer between 1 and ${MAX_BEHAVIOR_DAYS}`;
const NEED_COUNT = `count must be an integer between 1 and ${MAX_BEHAVIOR_COUNT}`;
const NAME_ONLY_CONVERSION = "name is only supported for conversion rules";

/**
 * 두 규칙을 `_k` 태그로 갈라 놓고 검사한다.
 *
 * 태그 없이 `z.union` 을 쓰면 한쪽이 틀렸을 때 두 갈래의 오류가 뭉쳐 "Invalid input"
 * 하나만 남는다 — 어느 칸이 왜 틀렸는지 화면에 전할 수 없다. 모양(`source` 유무)으로
 * 먼저 갈라야 "days 는 1~365 정수" 같은 말을 그대로 돌려줄 수 있다.
 */
const taggedRule = z
  .discriminatedUnion("_k", [
    z.object({
      _k: z.literal("attribute"),
      attribute: z.string().min(1).max(64),
      op: z.enum(RULE_OPS).optional(),
      value: z.string().max(255),
    }),
    z.object({
      _k: z.literal("behavior"),
      source: z.enum(BEHAVIOR_SOURCES),
      op: z.enum(BEHAVIOR_OPS),
      days: z.number().int().min(1).max(MAX_BEHAVIOR_DAYS).optional(),
      count: z.number().int().min(1).max(MAX_BEHAVIOR_COUNT).optional(),
      name: z.string().min(1).max(64).optional(),
    }),
  ])
  .superRefine((r, ctx) => {
    if (r._k === "attribute") {
      if (isNumericOp(r.op) && !isNumericValue(r.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: NEED_NUMBER, path: ["value"] });
      }
      return;
    }
    if (needsDays(r.op) && r.days === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: NEED_DAYS, path: ["days"] });
    }
    if (r.op === "count_gte" && r.count === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: NEED_COUNT, path: ["count"] });
    }
    if (r.name !== undefined && !supportsName(r.source)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: NAME_ONLY_CONVERSION, path: ["name"] });
    }
  });

function tagRule(v: unknown): unknown {
  if (!v || typeof v !== "object" || Array.isArray(v)) return v;
  return { ...(v as Record<string, unknown>), _k: "source" in v ? "behavior" : "attribute" };
}

/** 규칙 하나 = 속성 규칙 또는 행동 규칙. 저장 전 군더더기(쓰이지 않는 칸)는 떨어뜨린다. */
export const ruleSchema = z.preprocess(tagRule, taggedRule).transform((r): TopicRule => {
  if (r._k === "attribute") {
    return r.op === undefined
      ? { attribute: r.attribute, value: r.value }
      : { attribute: r.attribute, op: r.op, value: r.value };
  }
  // count_gte 가 아닌데 남은 count, 전환이 아닌데 남은 name 은 조건에 쓰이지 않는다 —
  // 그대로 저장하면 나중에 규칙을 읽는 사람이 있지도 않은 조건을 있다고 읽는다.
  return {
    source: r.source,
    op: r.op,
    ...(r.days !== undefined ? { days: r.days } : {}),
    ...(r.op === "count_gte" && r.count !== undefined ? { count: r.count } : {}),
    ...(supportsName(r.source) && r.name !== undefined ? { name: r.name } : {}),
  };
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

/**
 * 행동 기록에서 "이 기기"를 찾는 방법.
 *
 * 여기가 핵심이다. 규칙식 경로는 `push_users` 를 조인해 유저 속성을 보지만, **행동은
 * 기기에 남는다**. 사람이 없는 기기(익명)도 클릭하고 앱을 연다. 그래서 주체 조건은
 * 기기 id 를 먼저 보고, 사람이 있을 때만 사람 id 로 넓힌다 — 익명 기기를 버리지 않으려면
 * 조인이 아니라 여기서 기기 id 를 봐야 한다.
 */
const CLICKED_BY = sql`(b.device_id = ${devices.id} or (${devices.userId} is not null and b.user_id = ${devices.userId}))`;

function since(days: number): SQL {
  return sql`now() - make_interval(days => ${days}::int)`;
}

type BehaviorSpec = {
  /** 서브쿼리의 FROM. 별칭 b 로 고정한다 — 바깥 devices 와 컬럼 이름이 겹친다. */
  from: SQL;
  subject: SQL;
  recent: (days: number) => SQL;
};

function behaviorSpec(r: BehaviorRule): BehaviorSpec {
  if (r.source === "click") {
    return { from: sql`${pushClicks} b`, subject: CLICKED_BY, recent: (d) => sql`b.clicked_at >= ${since(d)}` };
  }
  if (r.source === "conversion") {
    return { from: sql`${pushConversions} b`, subject: CLICKED_BY, recent: (d) => sql`b.created_at >= ${since(d)}` };
  }
  if (r.source === "activity") {
    // 접속은 기기 단위로만 본다 — 롤업 자체가 (기기, 날짜)이고, "이 기기가 잠들었나"가
    // 묻는 것이다. 사람으로 넓히면 다른 기기의 접속이 이 기기를 깨운다.
    // day 는 UTC 날짜(schema 주석) — 서버 로컬시각으로 빼면 배포 지역마다 답이 달라진다.
    return {
      from: sql`${deviceActivity} b`,
      subject: sql`b.device_id = ${devices.id}`,
      recent: (d) => sql`b.day >= ((now() at time zone 'utc')::date - ${d}::int)`,
    };
  }
  // push_user_sends 에는 device_id 가 없다. 익명 기기는 여기에 흔적을 남기지 못하므로
  // "받았다"는 항상 거짓, "안 받았다"는 항상 참이 된다 — user_id 비교가 그대로 그 답을 낸다.
  return {
    from: sql`${pushUserSends} b`,
    subject: sql`(${devices.userId} is not null and b.user_id = ${devices.userId})`,
    recent: (d) => sql`b.sent_at >= ${since(d)}`,
  };
}

/** 행동 규칙 하나 → EXISTS/NOT EXISTS(또는 개수) 서브쿼리. */
export function behaviorCond(r: BehaviorRule, projectId: string): SQL {
  if (!isBehaviorUsable(r)) return sql`false`;

  const spec = behaviorSpec(r);
  // project_id 를 함께 거는 이유는 정확성이 아니라 인덱스다 — 행동 테이블의 인덱스가
  // 전부 (project_id, ...) 로 시작해서, 빼면 프로젝트 전체를 훑는다.
  const conds: SQL[] = [sql`b.project_id = ${projectId}`, spec.subject];
  if (supportsName(r.source) && r.name) conds.push(sql`b.name = ${r.name}`);
  if (isIntInRange(r.days, 1, MAX_BEHAVIOR_DAYS)) conds.push(spec.recent(r.days));
  const where = sql.join(conds, sql` and `);

  if (r.op === "count_gte") {
    return sql`(select count(*) from ${spec.from} where ${where}) >= ${r.count}::int`;
  }
  const exists = sql`exists (select 1 from ${spec.from} where ${where})`;
  return r.op === "not_within_days" ? sql`not ${exists}` : exists;
}

/**
 * 규칙 하나 → SQL 조건. 속성명·값·기간은 모두 바인드 파라미터라 주입되지 않는다.
 *
 * 규칙이 SQL 이 되는 곳은 여기 하나다. resolveScope(발송)·countTopicAudience(도달 인원)·
 * click-eligibility(클릭 자격)가 전부 이 함수를 지나므로, 규칙 종류가 늘어도 세 곳이
 * 저절로 같은 답을 말한다.
 */
export function ruleCond(r: TopicRule, projectId: string): SQL {
  if (isBehaviorRule(r)) return behaviorCond(r, projectId);

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

/** 규칙(AND) → SQL 조건 목록. 발송·도달 인원·클릭 자격이 모두 이 함수를 쓴다. */
export function attrConds(rules: TopicRule[], projectId: string): SQL[] {
  return rules.map((r) => ruleCond(r, projectId));
}

/** 규칙식 그룹인가 — 빈 배열은 규칙식으로 치지 않는다(위 min(1) 과 같은 이유). */
export function isRuleFilled(rules: TopicRule[] | null): rules is TopicRule[] {
  return Boolean(rules && rules.length > 0);
}

/**
 * 토픽 규모 — 구독식은 subscriptions 를, 규칙식은 규칙 조건을 센다.
 * 발송 대상과 같은 기준(활성·비억제)을 써야 목록·상세·삭제 경고가 발송 추정과 같은 수를 말한다.
 * 행을 가져오지 않고 SQL 집계 한 번으로 센다.
 *
 * push_users 는 **left join** 이다(audience-count 의 rules 경로와 같은 이유).
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
          .leftJoin(pushUsers, eq(devices.userId, pushUsers.id))
          .where(and(...base, ...attrConds(topic.rules, projectId)))
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
