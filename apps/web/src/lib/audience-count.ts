import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { getDb } from "@/db/client";
import { devices, pushUsers, topics, subscriptions, suppressions, type PushLog } from "@/db/schema";
import { attrConds, isRuleFilled, type TopicRule } from "@/lib/topic-membership";

export type Db = ReturnType<typeof getDb>;

/** 대상 해석에 필요한 필드만 — 저장된 발송 로그와 발송 전 추정 요청이 같은 모양을 쓴다 */
export type AudienceTarget = Pick<PushLog, "projectId" | "type" | "target" | "targets">;

export type PlatformCounts = { ios: number; android: number; web: number; other: number };

export type Audience = { users: number; devices: number; platforms: PlatformCounts };

/**
 * 억제(수신거부) 제외 조건 — 토큰 직접 억제 + external_id 억제 유저의 기기.
 *
 * 예전에는 억제 목록을 통째로 메모리에 올려 `inArray` 로 걸었다. 목록이 수만 건이 되면
 * 바인드 파라미터 한도(65535)를 넘어 발송 자체가 실패한다. NOT EXISTS 는 DB 안에서 끝난다.
 */
export function notSuppressed(projectId: string): SQL {
  return sql`not exists (
      select 1 from ${suppressions} s
      where s.project_id = ${projectId} and s.token = ${devices.token}
    ) and not exists (
      select 1 from ${suppressions} s
      join ${pushUsers} su on su.project_id = s.project_id and su.external_id = s.external_id
      where s.project_id = ${projectId} and su.id = ${devices.userId}
    )`;
}

/**
 * 사람 단위 억제 제외 — external_id 로 수신거부한 유저. 인박스·알림톡 같은 후속 채널은
 * 기기가 아니라 사람에게 가므로 이 조건을 건다(push_users 를 대상으로 하는 쿼리에서).
 */
export function userNotSuppressed(projectId: string): SQL {
  return sql`not exists (
      select 1 from ${suppressions} s
      where s.project_id = ${projectId} and s.external_id = ${pushUsers.externalId}
    )`;
}

/**
 * 토픽 해석 — 토픽 하나가 두 방식 중 하나로 명단을 갖는다.
 *
 * `rules` 가 비어 있으면 구독식으로 본다. 규칙 0개를 규칙식으로 받으면
 * "조건 없음 = 전원"이 되어 실수로 전체 발송이 된다. 빈 배열은 API 에서도 막지만,
 * 과거 데이터나 직접 UPDATE 로 들어올 수 있어 여기서도 한 번 더 막는다.
 */
export type Group =
  | { kind: "rules"; rules: TopicRule[] }
  | { kind: "subs"; topicId: string };

export async function resolveGroup(db: Db, projectId: string, name: string): Promise<Group | null> {
  const t = (
    await db.select({ id: topics.id, rules: topics.rules }).from(topics)
      .where(and(eq(topics.projectId, projectId), eq(topics.name, name))).limit(1)
  )[0];
  if (!t) return null;
  return isRuleFilled(t.rules) ? { kind: "rules", rules: t.rules } : { kind: "subs", topicId: t.id };
}

/** multi 발송의 받는 사람 → 존재하는 유저 id. 없는 아이디는 조용히 빠진다(분모에도 안 잡힌다). */
export async function resolveMultiUsers(db: Db, t: AudienceTarget): Promise<string[]> {
  const ids = t.targets ?? [];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: pushUsers.id }).from(pushUsers)
    .where(and(eq(pushUsers.projectId, t.projectId), inArray(pushUsers.externalId, ids)));
  return rows.map((r) => r.id);
}

/**
 * 발송 대상 = 활성·비억제 기기 집합을 고르는 방법. 발송 처리기와 도달 인원 집계가 같은 것을 쓴다 —
 * 따로 만들면 "추정 N명"과 실제 로그의 대상 수가 어긋난다.
 *
 * - `devices`: devices 만 (broadcast·single·multi)
 * - `rules`  : devices ⋈ push_users (규칙식 토픽 — 속성 조건)
 * - `subs`   : subscriptions ⋈ devices (구독식 토픽 — 커서는 subscriptions.device_id 순서라
 *              (topic_id, device_id) 유니크 인덱스를 그대로 탄다)
 */
export type DeviceScope =
  | { kind: "devices"; conds: SQL[] }
  | { kind: "rules"; conds: SQL[] }
  | { kind: "subs"; topicId: string; conds: SQL[] };

export async function resolveScope(db: Db, t: AudienceTarget): Promise<DeviceScope | null> {
  const base = [eq(devices.projectId, t.projectId), eq(devices.isActive, true), notSuppressed(t.projectId)];

  if (t.type === "single") {
    if (!t.target) return null;
    const u = (
      await db.select({ id: pushUsers.id }).from(pushUsers)
        .where(and(eq(pushUsers.projectId, t.projectId), eq(pushUsers.externalId, t.target))).limit(1)
    )[0];
    // 없는 external_id 로 보내면 수신자가 0인데 분모만 1이 되어 클릭률이 영원히 0% 로 남는다
    if (!u) return null;
    return { kind: "devices", conds: [...base, eq(devices.userId, u.id)] };
  }

  if (t.type === "multi") {
    const userIds = await resolveMultiUsers(db, t);
    if (userIds.length === 0) return null;
    return { kind: "devices", conds: [...base, inArray(devices.userId, userIds)] };
  }

  // 'segment' 는 통합 이전에 쌓인 로그 — 같은 이름의 토픽으로 흡수됐으므로 같은 경로로 처리한다.
  if (t.type === "topic" || t.type === "segment") {
    if (!t.target) return null;
    const group = await resolveGroup(db, t.projectId, t.target);
    if (!group) return null;
    if (group.kind === "rules") return { kind: "rules", conds: [...base, ...attrConds(group.rules)] };
    return { kind: "subs", topicId: group.topicId, conds: base };
  }

  return { kind: "devices", conds: base };
}

/** 기기 한 행 — 발송 페이지 단위 */
export type ScopedDevice = { id: string; token: string; userId: string | null; platform: string };

const deviceFields = { id: devices.id, token: devices.token, userId: devices.userId, platform: devices.platform };

/** 커서(기기 id) 다음부터 `limit` 개. 구독식은 subscriptions.device_id 로 정렬·커서를 건다. */
export async function scopedDevicePage(db: Db, scope: DeviceScope, cursor: string, limit: number): Promise<ScopedDevice[]> {
  if (scope.kind === "subs") {
    return db
      .select(deviceFields)
      .from(subscriptions)
      .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
      .where(and(eq(subscriptions.topicId, scope.topicId), gt(subscriptions.deviceId, cursor), ...scope.conds))
      .orderBy(asc(subscriptions.deviceId))
      .limit(limit);
  }
  if (scope.kind === "rules") {
    return db
      .select(deviceFields)
      .from(devices)
      .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
      .where(and(gt(devices.id, cursor), ...scope.conds))
      .orderBy(asc(devices.id))
      .limit(limit);
  }
  return db
    .select(deviceFields)
    .from(devices)
    .where(and(gt(devices.id, cursor), ...scope.conds))
    .orderBy(asc(devices.id))
    .limit(limit);
}

type CountRow = { devices: number; users: number; ios: number; android: number; web: number };

const countFields = {
  devices: sql<number>`count(*)::int`,
  users: sql<number>`count(distinct ${devices.userId})::int`,
  ios: sql<number>`(count(*) filter (where ${devices.platform} = 'ios'))::int`,
  android: sql<number>`(count(*) filter (where ${devices.platform} = 'android'))::int`,
  web: sql<number>`(count(*) filter (where ${devices.platform} = 'web'))::int`,
};

/**
 * 집계 행 → Audience (순수 함수 — 단위 테스트 대상).
 *
 * 플랫폼 버킷: 발송 경로는 `web` 만 data-only 로 따로 보내므로 웹은 그것만 센다.
 * flutter·react-native·webview·electron 은 등록 값만으로 OS 를 알 수 없어 `other` 로 둔다 —
 * 추측해서 iOS/Android 에 섞으면 미리보기 판단(잘림)이 틀어진다.
 */
export function audienceFromCounts(r: CountRow): Audience {
  const n = (v: unknown) => Number(v) || 0;
  const total = n(r.devices);
  const ios = n(r.ios);
  const android = n(r.android);
  const web = n(r.web);
  return {
    users: n(r.users),
    devices: total,
    platforms: { ios, android, web, other: Math.max(0, total - ios - android - web) },
  };
}

export const EMPTY_AUDIENCE: Audience = { users: 0, devices: 0, platforms: { ios: 0, android: 0, web: 0, other: 0 } };

async function countScope(db: Db, scope: DeviceScope): Promise<CountRow> {
  if (scope.kind === "subs") {
    return (
      await db.select(countFields).from(subscriptions)
        .innerJoin(devices, eq(subscriptions.deviceId, devices.id))
        .where(and(eq(subscriptions.topicId, scope.topicId), ...scope.conds))
    )[0];
  }
  if (scope.kind === "rules") {
    return (
      await db.select(countFields).from(devices)
        .innerJoin(pushUsers, eq(devices.userId, pushUsers.id))
        .where(and(...scope.conds))
    )[0];
  }
  return (await db.select(countFields).from(devices).where(and(...scope.conds)))[0];
}

/**
 * 발송 대상의 **고유 유저 수**와 **디바이스 수**(+플랫폼별 디바이스 수).
 *
 * 발송 처리기는 이 값을 클릭률 분모로 발송 시작 전에 확정하고, 콘솔은 같은 함수로
 * 발송 전 도달 인원을 보여 준다. 따로 세면 "추정 N명"과 실제 로그의 대상 수가 어긋난다.
 *
 * 두 값을 모두 남기는 이유: 익명 디바이스(userId null)는 유저 분모에 0으로 잡히는데
 * 그 디바이스의 클릭은 clickCount 를 올린다. 짝이 맞는 분모가 없으면 100% 를 넘는 비율이 나온다.
 *
 * 행을 애플리케이션으로 가져와 세면 수십만 대상에서 메모리·전송량이 폭증한다 — SQL 집계 한 번으로 끝낸다.
 */
export async function countAudience(db: Db, t: AudienceTarget): Promise<Audience> {
  const scope = await resolveScope(db, t);
  if (!scope) return { ...EMPTY_AUDIENCE, platforms: { ...EMPTY_AUDIENCE.platforms } };
  return audienceFromCounts(await countScope(db, scope));
}
