import { and, eq, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { messageTemplates, pushLogs, type PushLog } from "@/db/schema";
import { applyTemplate, isReservedKey, MAX_TEMPLATE_FIELDS } from "@/lib/templates";
import { nextAllowedTime } from "@/lib/quiet-hours";
import { buildMulticast, type PushOptions } from "@/lib/fcm";
import { hasPlaceholders } from "@/lib/personalize";
import {
  AB_SAMPLE_MIN,
  AB_SAMPLE_MAX,
  AB_WAIT_MIN_MINUTES,
  AB_WAIT_MAX_MINUTES,
  type AbTest,
  type AbTestPlan,
} from "@/lib/ab-test";
import {
  isLocaleKey,
  LOCALE_DEFAULT_KEY,
  MAX_LOCALE_VARIANTS,
  normalizeLocaleTag,
  type LocaleContent,
} from "@/lib/locale-content";
import { HOLDOUT_MAX, HOLDOUT_MIN } from "@/lib/holdout";
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
  /**
   * 받는 사람 현지 시각 발송 — "HH:MM"(24시간). 기기의 시간대(사람 > 기기 등록값 > 프로젝트)로 묶어,
   * 아직 그 시각이 안 된 묶음은 다음 회차로 미룬다. 하루가 지나면 남은 묶음도 즉시 보낸다.
   * `scheduled_at`·방해금지·빈도 상한과 함께 쓸 수 있다(그 규칙들을 건너뛰지 않는다).
   */
  local_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "local_time must be HH:MM")
    .optional(),
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
  /**
   * A/B 자동 승자. 표본(`sample_percent`)에게 먼저 보내고 `wait_minutes` 뒤 유니크 클릭률이
   * 가장 좋은 변형을 **나머지**에게 한 번 더 보낸다(로그 1행 추가). 지표는 고정이라 받지 않는다.
   * `variants` 가 있어야 하고, 한 사람에게 가는 발송(single)에는 쓸 수 없다 — `abTestError` 참고.
   */
  ab_test: z
    .object({
      sample_percent: z.number().int().min(AB_SAMPLE_MIN).max(AB_SAMPLE_MAX),
      wait_minutes: z.number().int().min(AB_WAIT_MIN_MINUTES).max(AB_WAIT_MAX_MINUTES),
    })
    .optional(),
  /**
   * 로케일별 제목·본문 — `{ "default": {...}, "ko": {...}, "ja": {...} }`.
   * fan-out 때 사람 > 기기의 `locale` 로 고르고, 맞는 것이 없으면 `default`(없으면 title/body).
   * 폴백 건수는 로그(`locale_fallbacks`)와 상세 API 에 남는다 — 조용히 떨어지지 않는다.
   */
  locales: z
    .record(z.object({ title: z.string().min(1).max(255), body: z.string().min(1).max(4000) }))
    .refine((m) => Object.keys(m).length >= 1, "locales must not be empty")
    .refine((m) => Object.keys(m).length <= MAX_LOCALE_VARIANTS, `at most ${MAX_LOCALE_VARIANTS} locales`)
    .superRefine((m, ctx) => {
      const bad = Object.keys(m).find((k) => !isLocaleKey(k));
      if (bad) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid locale key: ${bad}` });
      // "ko" 와 "ko-KR" 은 다른 키지만 "ko_KR" 과 "ko-KR" 은 같은 언어다 — 같은 값으로 접히는
      // 키를 둘 다 받으면 어느 쪽이 이기는지 입력만 보고 알 수 없다
      const seen = new Set<string>();
      for (const k of Object.keys(m)) {
        const norm = normalizeLocaleTag(k);
        if (seen.has(norm)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate locale key: ${k}` });
        seen.add(norm);
      }
    })
    .optional(),
  /**
   * 홀드아웃 — 이 비율(%)의 사람에게는 **아무것도 보내지 않고** 전환만 비교한다.
   * 배정은 사람(없으면 기기) 단위로 고정이라 캠페인마다 대조군이 다시 뽑히지 않는다.
   */
  holdout_percent: z.number().int().min(HOLDOUT_MIN).max(HOLDOUT_MAX).optional(),
  /**
   * 캠페인별 재정의 — `false` 면 프로젝트 방해금지 시간대를 무시하고 즉시 보낸다.
   * 거래성 발송(주문·인증)이 마케팅용 야간 금지에 걸려 아침으로 밀리는 것을 막는다.
   */
  quiet_hours: z.boolean().optional(),
  /**
   * 캠페인별 속도 제한(분당 건수) 재정의. `0` 은 "이 발송은 제한 없음"이다 —
   * 주지 않으면 프로젝트 설정을 그대로 따른다.
   */
  max_sends_per_minute: z.number().int().min(0).max(1_000_000).optional(),
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
  const targetErr = targetError(b) ?? abTestError(b) ?? localeVariantsError(b) ?? holdoutError(b);
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
  m: Pick<ReadyMessage, "title" | "body" | "data" | "deep_link" | "image_url" | "variants" | "options" | "locales">
): number {
  // 로케일 문구도 실제로 나가는 페이로드다 — 빼고 재면 긴 번역이 큐잉만 통과하고 FCM 에서 전부 거절된다
  const contents = [{ title: m.title, body: m.body }, ...(m.variants ?? []), ...Object.values(m.locales ?? {})];
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

/**
 * A/B 자동 승자를 쓸 수 있는 발송인지. null 이면 통과.
 *
 * 변형이 없으면 비교할 것이 없고, `single` 은 받는 사람이 하나라 표본과 나머지로 갈 수 없다
 * (갈라 보면 한쪽은 0명이라 승자 본발송이 아무에게도 가지 않는다).
 * 테스트 발송은 운영자 자신에게 가는 것이라 A/B 설정을 무시한다(거절하지는 않는다).
 */
export function abTestError(b: Pick<MessageInput, "type" | "variants" | "ab_test" | "test">): string | null {
  if (!b.ab_test || b.test) return null;
  if (!b.variants || b.variants.length < 2) return "ab_test requires at least 2 variants";
  if (b.type === "single") return "ab_test is not available for type=single";
  return null;
}

/** 입력 → 저장할 설정. 지표는 고정이라 여기서 채운다. */
export function abTestPlan(b: Pick<MessageInput, "ab_test" | "test">): AbTestPlan | null {
  if (!b.ab_test || b.test) return null;
  return {
    role: "test",
    samplePercent: b.ab_test.sample_percent,
    waitMinutes: b.ab_test.wait_minutes,
    metric: "unique_click_rate",
  };
}

/**
 * 로케일 문구를 쓸 수 있는 발송인지. null 이면 통과.
 *
 * `variants`(A/B)와 함께 쓰지 못하게 막는다 — 두 축을 곱하면 운영자가 변형 × 로케일을 전부
 * 채워야 하고, 빈 칸 하나가 기본 문구로 떨어질 때 그게 어느 축의 폴백인지 구분할 수 없다.
 * `default` 없이 보내는 것은 허용한다: 그때는 발송 본문(title/body)이 기본 문구다.
 */
export function localeVariantsError(b: Pick<MessageInput, "locales" | "variants" | "title" | "body" | "template" | "options" | "type">): string | null {
  if (!b.locales) return null;
  if (b.variants?.length) return "locales cannot be combined with variants";
  // 기본 문구가 어디에도 없으면 맞는 로케일이 없는 사람에게 빈 알림이 간다
  const hasBase = Boolean((b.title && b.body) || b.template || b.locales[LOCALE_DEFAULT_KEY] || b.options?.silent);
  return hasBase ? null : "locales requires title/body, a template, or a \"default\" entry";
}

/**
 * 홀드아웃을 쓸 수 있는 발송인지. null 이면 통과.
 * `single` 은 받는 사람이 한 명이라 대조군이 "전부 빼거나 아무도 안 빼거나"가 되어 의미가 없고,
 * 하필 그 한 명이 빠지면 운영자는 "보냈는데 안 갔다"로 읽는다.
 */
export function holdoutError(b: Pick<MessageInput, "type" | "holdout_percent" | "test">): string | null {
  if (!b.holdout_percent || b.test) return null;
  if (b.type === "single") return "holdout_percent is not available for type=single";
  return null;
}

/** 타입별 대상 필드 검사 — 콘솔(admin)과 SDK(v1) 발송이 같은 규칙을 쓴다. null 이면 통과. */
export function targetError(b: Pick<MessageInput, "type" | "target" | "targets">): string | null {
  if (b.type === "multi") return b.targets?.length ? null : "targets is required for type=multi";
  if (b.type !== "broadcast" && !b.target) return "target is required unless type=broadcast";
  return null;
}

/**
 * 큐잉에 필요한 프로젝트 값. `timezone` 은 방해금지 시간대를 재는 기준이다 —
 * 필수로 둔다: 선택값이던 때 콘솔 발송·저니가 이 칼럼을 빼먹어 UTC 로 판정했고,
 * KST 프로젝트가 한밤중에 보냈다. 시간대가 정말 없으면 null 을 명시한다.
 */
export type EnqueueProject = {
  id: string;
  quietStartHour: number | null;
  quietEndHour: number | null;
  timezone: string | null;
};

export type EnqueueOptions = {
  /** 발송자 — 콘솔 멤버 이메일 · "admin-token" · "api" · "journey" · "ab-winner" */
  sentBy?: string;
  idempotencyKey?: string | null;
  db?: DbOrTx;
  /**
   * 저장할 A/B 표식을 직접 준다. 승자 본발송은 요청이 아니라 **처리기**가 만들어
   * `role:"winner"` 를 붙이므로 본문(`ab_test`)으로는 표현할 수 없다.
   */
  abTest?: AbTest;
  /**
   * 이 발송을 만든 저니 스텝. 스텝별 퍼널(발송·클릭·전환)의 유일한 귀속 경로다 —
   * 로그에 적지 않으면 나중에 "이 발송이 어느 단계에서 나갔는지"를 복원할 방법이 없다.
   */
  journey?: { id: string; stepPath: string };
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

  // 테스트 발송은 방해금지 시간대를 적용하지 않는다 — 운영자가 지금 받아 보려고 보내는 것이다.
  // `quiet_hours: false` 는 캠페인별 재정의다: 거래성 발송이 마케팅용 야간 금지에 밀리지 않는다.
  if (!b.scheduled_at && !b.test && b.quiet_hours !== false) {
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
      abTest: opts.abTest ?? abTestPlan(b),
      localeVariants: (b.locales as LocaleContent | undefined) ?? null,
      // 테스트 발송에서 대조군을 뽑으면 운영자 자신이 빠져 "안 왔다"로 보인다
      holdoutPercent: b.test ? null : (b.holdout_percent ?? null),
      ignoreQuietHours: b.quiet_hours === false,
      // 0 = "이 발송은 제한 없음". undefined 와 구분해야 프로젝트 설정을 덮는지 알 수 있다.
      maxSendsPerMinute: b.max_sends_per_minute ?? null,
      options: b.options ?? null,
      kakaoFallback: b.kakao_fallback ?? false,
      scheduledAt,
      localTime: b.local_time ?? null,
      status: isScheduled ? "scheduled" : "queued",
      sentBy: opts.sentBy ?? null,
      journeyId: opts.journey?.id ?? null,
      stepPath: opts.journey?.stepPath ?? null,
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
