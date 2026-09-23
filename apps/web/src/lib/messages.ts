import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messageTemplates, pushLogs, type PushLog } from "@/db/schema";
import { applyTemplate, isReservedKey, MAX_TEMPLATE_FIELDS } from "@/lib/templates";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { buildMulticast, type PushOptions } from "@/lib/fcm";
import { hasPlaceholders } from "@/lib/personalize";
import { z } from "zod";

type Db = ReturnType<typeof getDb>;
/** 트랜잭션 안에서도 같은 함수를 쓰도록 — 저니는 advance 와 큐잉을 한 트랜잭션으로 묶는다 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 다중 발송 한 건의 최대 인원 — 이보다 많으면 토픽으로 묶는 게 맞다 */
export const MAX_MULTI_TARGETS = 1000;

/** 발송 요청 본문 상한 — 기본 32KB 로는 다중 발송 1000명 목록이 들어가지 않는다 */
export const MESSAGE_BODY_LIMIT = 96 * 1024;

/**
 * `data` 안의 예약 키 — 템플릿 커스텀 필드와 같은 목록이다.
 * 받아 주면 딥링크·클릭 추적(`notikit_log_id`)을 덮어쓰거나 FCM 이 발송 자체를 거부한다.
 */
export function reservedDataKey(data: Record<string, unknown> | undefined): string | null {
  return Object.keys(data ?? {}).find(isReservedKey) ?? null;
}

const reservedKeyMessage = (key: string) => `data key is reserved: ${key}`;

/**
 * 이미지 URL 은 https 만. 기기(FCM·APNs 확장·브라우저)가 직접 내려받는데 iOS ATS 와
 * 브라우저 혼합 콘텐츠 규칙이 http 를 막아, 받아 두면 "보냈는데 이미지가 안 뜨는" 발송이 된다.
 */
export const IMAGE_URL_MAX = 2048;

function isHttpsUrl(u: string): boolean {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

/** FCM 이 받는 TTL 최대치 — 28일 */
export const TTL_SECONDS_MAX = 2_419_200;
/** 알림 액션 버튼 최대 개수 — Android·웹이 3개까지만 그린다 */
export const MAX_PUSH_ACTIONS = 3;

const pushActionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  title: z.string().trim().min(1).max(64),
  deep_link: z.string().url().max(2048).optional(),
});

/**
 * 알림 옵션. 플랫폼별 자리 매핑은 `buildMulticast` 가 한다 — 여기서는 받아들일 값의 범위만 정한다.
 * `priority` 는 주지 않으면 high: 푸시는 즉시 도착하는 것이 기본 기대값이다.
 */
export const pushOptionsSchema = z.object({
  sound: z.string().trim().min(1).max(64).optional(),
  badge: z.number().int().min(0).max(99_999).optional(),
  collapse_key: z.string().trim().min(1).max(64).optional(),
  android_channel_id: z.string().trim().min(1).max(64).optional(),
  ios_thread_id: z.string().trim().min(1).max(64).optional(),
  ttl_seconds: z.number().int().min(0).max(TTL_SECONDS_MAX).optional(),
  priority: z.enum(["normal", "high"]).default("high"),
  silent: z.boolean().optional(),
  actions: z
    .array(pushActionSchema)
    .max(MAX_PUSH_ACTIONS)
    .refine((a) => new Set(a.map((x) => x.id)).size === a.length, "action ids must be unique")
    .optional(),
}) satisfies z.ZodType<PushOptions, z.ZodTypeDef, unknown>;

/** 푸시 발송 입력 스키마 (App SDK /v1/messages 와 Web Admin 발송이 공유) */
export const messageSchema = z.object({
  // 템플릿을 쓰면 비워도 된다 — prepareMessage 가 채운 뒤 비어 있으면 거절한다
  title: z.string().max(255).optional(),
  body: z.string().max(4000).optional(),
  /** 콘솔에서 만든 메시지 템플릿 이름. 제목·본문·딥링크·커스텀 필드를 채운다. */
  template: z.string().trim().min(1).max(120).optional(),
  /** 템플릿이 정의한 커스텀 필드 값 → 푸시 data */
  fields: z
    .record(z.string().max(500))
    .optional()
    .refine((f) => !f || Object.keys(f).length <= MAX_TEMPLATE_FIELDS, `at most ${MAX_TEMPLATE_FIELDS} fields`),
  type: z.enum(["single", "multi", "broadcast", "topic", "segment"]),
  target: z.string().max(255).optional(),
  /** type=multi 의 받는 사람. 중복은 서버에서 합친다. */
  targets: z.array(z.string().min(1).max(255)).min(1).max(MAX_MULTI_TARGETS).optional(),
  scheduled_at: z.string().datetime().optional(),
  deep_link: z.string().url().max(2048).optional(),
  /** 리치 알림 이미지 — Android·iOS·웹 알림에 크게 표시 */
  image_url: z.string().url().max(IMAGE_URL_MAX).refine(isHttpsUrl, "image_url must be an https URL").optional(),
  /** 테스트 발송 표시 — 콘솔(admin) 라우트에서만 반영한다. v1 은 라우트에서 버린다. */
  test: z.boolean().optional(),
  data: z
    .record(z.unknown())
    .optional()
    .refine((d) => !d || Buffer.byteLength(JSON.stringify(d), "utf8") <= 8192, "data too large (max 8KB)")
    .superRefine((d, ctx) => {
      const key = reservedDataKey(d);
      if (key) ctx.addIssue({ code: z.ZodIssueCode.custom, message: reservedKeyMessage(key) });
    }),
  variants: z
    .array(z.object({ title: z.string().min(1).max(255), body: z.string().min(1).max(4000) }))
    .min(2)
    .max(5)
    .optional(),
  kakao_fallback: z.boolean().optional(),
  /** 알림 옵션(소리·배지·collapse·TTL·우선순위·무음·액션 버튼) */
  options: pushOptionsSchema.optional(),
});

export type MessageInput = z.infer<typeof messageSchema>;

/**
 * 템플릿·검증을 거쳐 큐에 넣을 수 있게 된 발송 — 제목·본문이 확정돼 있다.
 * `options` 는 스키마 출력(priority 기본값이 채워진 형태)이 아니라 느슨한 `PushOptions` 로 둔다 —
 * 콘솔처럼 스키마를 거치지 않고 옵션을 만드는 호출부가 기본값까지 채우게 만들 이유가 없다.
 */
export type ReadyMessage = Omit<MessageInput, "title" | "body" | "template" | "fields" | "options"> & {
  title: string;
  body: string;
  options?: PushOptions;
};

const DATA_LIMIT_BYTES = 8192;

/**
 * 발송 요청 → 큐에 넣을 메시지. 콘솔(admin)과 SDK(v1)가 같은 규칙을 쓴다.
 * 대상 검사 → 템플릿 적용 → 제목·본문·data 크기 확인 순서.
 */
export async function prepareMessage(
  projectId: string,
  b: MessageInput
): Promise<{ message: ReadyMessage } | { error: string; status: number }> {
  const targetErr = targetError(b);
  if (targetErr) return { error: targetErr, status: 422 };

  const { template, fields, ...rest } = b;
  let merged: MergedMessage = rest;

  if (template) {
    const tpl = (
      await getDb()
        .select()
        .from(messageTemplates)
        .where(and(eq(messageTemplates.projectId, projectId), eq(messageTemplates.name, template)))
        .limit(1)
    )[0];
    if (!tpl) return { error: `Template not found: ${template}`, status: 404 };
    const applied = applyTemplate(tpl, { title: b.title, body: b.body, deep_link: b.deep_link, data: b.data, fields });
    if ("error" in applied) return { error: applied.error, status: 422 };
    merged = { ...rest, ...applied };
  } else if (fields) {
    return { error: "fields requires template", status: 422 };
  }

  return finalizeMessage(merged);
}

type MergedMessage = Omit<ReadyMessage, "title" | "body"> & { title?: string; body?: string };

/**
 * 템플릿과 합친 뒤의 최종 검사. 스키마는 요청의 `data` 만 봤으므로
 * 템플릿 필드와 합친 결과를 여기서 한 번 더 본다 — 예약 키 규칙이 생기기 전에 저장된 템플릿도 막는다.
 */
export function finalizeMessage(merged: MergedMessage): { message: ReadyMessage } | { error: string; status: number } {
  // 무음 푸시는 알림을 그리지 않으므로 제목·본문 없이 data 만으로도 성립한다
  const silent = merged.options?.silent === true;
  if (!silent && (!merged.title || !merged.body)) {
    return { error: "title and body are required (directly or via template)", status: 422 };
  }
  const reserved = reservedDataKey(merged.data);
  if (reserved) return { error: reservedKeyMessage(reserved), status: 422 };
  if (merged.data && Buffer.byteLength(JSON.stringify(merged.data), "utf8") > DATA_LIMIT_BYTES) {
    return { error: "data too large (max 8KB)", status: 422 };
  }
  const message = { ...merged, title: merged.title ?? "", body: merged.body ?? "" };
  const bytes = payloadBytes(message);
  if (bytes > FCM_PAYLOAD_LIMIT) {
    return { error: `payload too large for FCM (${bytes} bytes, max ${FCM_PAYLOAD_LIMIT})`, status: 422 };
  }
  return { message };
}

/** FCM 이 받는 메시지 페이로드 상한(바이트) */
export const FCM_PAYLOAD_LIMIT = 4096;
/**
 * 치환 여유분. 크기는 치환 전 템플릿으로 재지만 `{{name}}` 이 긴 이름으로 바뀌면 커진다 —
 * 큐잉은 통과했는데 워커에서 FCM 이 전부 거절하는 발송을 막으려고 미리 뺀다.
 */
export const PERSONALIZE_HEADROOM = 512;
/** 발송 로그 id 자리 — 실제 값(uuid)과 같은 길이 */
const LOG_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/**
 * 최종 직렬화 크기 추정 — 네이티브(notification)와 웹(data-only) 모양 중 큰 쪽, 변형이 있으면 가장 긴 변형.
 * 치환 변수가 있으면 여유분을 더한다.
 */
export function payloadBytes(
  m: Pick<ReadyMessage, "title" | "body" | "data" | "deep_link" | "image_url" | "variants" | "options">
): number {
  const contents = [{ title: m.title, body: m.body }, ...(m.variants ?? [])];
  let max = 0;
  for (const c of contents) {
    const msg = {
      title: c.title,
      body: c.body,
      imageUrl: m.image_url,
      deepLink: m.deep_link,
      logId: LOG_ID_PLACEHOLDER,
      data: m.data,
      // 액션 버튼은 data 로 실리므로 4KB 검사에 반드시 포함해야 한다
      options: m.options,
    };
    for (const dataOnly of [false, true]) {
      max = Math.max(max, Buffer.byteLength(JSON.stringify(buildMulticast(msg, dataOnly)), "utf8"));
    }
  }
  const templated = hasPlaceholders(...contents.flatMap((c) => [c.title, c.body]));
  return max + (templated ? PERSONALIZE_HEADROOM : 0);
}

/** 타입별 대상 필드 검사 — 콘솔(admin)과 SDK(v1) 발송이 같은 규칙을 쓴다. null 이면 통과. */
export function targetError(b: Pick<MessageInput, "type" | "target" | "targets">): string | null {
  if (b.type === "multi") return b.targets?.length ? null : "targets is required for type=multi";
  if (b.type !== "broadcast" && !b.target) return "target is required unless type=broadcast";
  return null;
}

/**
 * 큐잉에 필요한 프로젝트 값. `timezone` 은 방해금지 시간대를 재는 기준이다 —
 * 선택값으로 둔 건 호출부가 프로젝트 행 전체를 읽지 않고 필요한 칼럼만 고르기 때문이고,
 * 주지 않으면 UTC 로 본다(칼럼이 생기기 전과 같은 동작).
 */
export type EnqueueProject = {
  id: string;
  quietStartHour: number | null;
  quietEndHour: number | null;
  timezone?: string | null;
};

export type EnqueueOptions = {
  /** 발송자 — 콘솔 멤버 이메일 · "admin-token" · "api" · "journey" */
  sentBy?: string;
  idempotencyKey?: string | null;
  db?: DbOrTx;
};

export const IDEMPOTENCY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY_RE = /^[\x21-\x7e]{1,255}$/;

/**
 * `Idempotency-Key` 헤더 해석. 없으면 null, 형식이 틀리면 error.
 * 출력 가능한 ASCII 1~255자만 받는다 — 공백·제어문자가 섞인 키는 클라이언트 버그일 가능성이 높다.
 */
export function parseIdempotencyKey(req: Request): { key: string | null } | { error: string } {
  const raw = req.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return { key: null };
  const key = raw.trim();
  if (!IDEMPOTENCY_KEY_RE.test(key)) return { error: "Idempotency-Key must be 1-255 printable ASCII characters" };
  return { key };
}

/** 같은 키로 이미 큐잉된 발송 — 재시도 요청에는 이것을 그대로 돌려준다 */
export async function findIdempotent(projectId: string, key: string, db: DbOrTx = getDb()): Promise<PushLog | undefined> {
  return (
    await db
      .select()
      .from(pushLogs)
      .where(and(eq(pushLogs.projectId, projectId), eq(pushLogs.idempotencyKey, key)))
      .limit(1)
  )[0];
}

/** v1 응답 DTO — 로그 행 전체(lock_token·resume_cursor 등 내부 값)를 내보내지 않는다 */
export function messageDto(m: Pick<PushLog, "id" | "status" | "scheduledAt">) {
  return { id: m.id, status: m.status, scheduled_at: m.scheduledAt ? m.scheduledAt.toISOString() : null };
}

/**
 * 발송 큐잉 — 로그(push_logs) 레코드 생성 후 즉시 ack. 실제 fan-out 은 worker.
 * 명시 scheduled_at 이 없으면 프로젝트 방해금지 시간대 규칙 적용.
 *
 * 멱등 키가 있으면 부분 유니크 인덱스로 충돌을 잡는다 — 동시에 같은 키로 두 요청이 와도
 * 하나만 들어가고, 진 쪽은 이긴 쪽의 행을 `replay: true` 로 돌려받는다.
 */
export async function enqueuePush(
  project: EnqueueProject,
  b: ReadyMessage,
  opts: EnqueueOptions = {}
): Promise<{ message: PushLog; scheduled: boolean; replay: boolean }> {
  let scheduledAt = b.scheduled_at ? new Date(b.scheduled_at) : null;
  let isScheduled = !!scheduledAt && scheduledAt.getTime() > Date.now();

  // 테스트 발송은 방해금지 시간대를 적용하지 않는다 — 운영자가 지금 받아 보려고 보내는 것이다
  if (!b.scheduled_at && !b.test) {
    const quietEnd = nextAllowedTime(project.quietStartHour, project.quietEndHour, new Date(), project.timezone);
    if (quietEnd) {
      scheduledAt = quietEnd;
      isScheduled = true;
    }
  }

  const db = opts.db ?? getDb();
  const key = opts.idempotencyKey ?? null;
  const insert = db
    .insert(pushLogs)
    .values({
      projectId: project.id,
      type: b.type,
      target: b.type === "multi" ? null : b.target,
      targets: b.type === "multi" ? [...new Set(b.targets)] : null,
      title: b.title,
      body: b.body,
      deepLink: b.deep_link,
      imageUrl: b.image_url,
      isTest: b.test ?? false,
      data: b.data,
      variants: b.variants,
      options: b.options ?? null,
      kakaoFallback: b.kakao_fallback ?? false,
      scheduledAt,
      status: isScheduled ? "scheduled" : "queued",
      sentBy: opts.sentBy ?? null,
      idempotencyKey: key,
    });
  const rows = key
    ? await insert
        .onConflictDoNothing({ target: [pushLogs.projectId, pushLogs.idempotencyKey], where: sql.raw(`"idempotency_key" is not null`) })
        .returning()
    : await insert.returning();

  if (rows[0]) return { message: rows[0], scheduled: isScheduled, replay: false };
  const existing = key ? await findIdempotent(project.id, key, db) : undefined;
  if (!existing) throw new Error("enqueuePush: insert returned no row");
  return { message: existing, scheduled: existing.status === "scheduled", replay: true };
}
