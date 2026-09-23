import { z } from "zod";

/**
 * 메시지 템플릿 — 제목·본문·딥링크와 커스텀 필드(푸시 `data`) 정의를 한 묶음으로 저장한다.
 * 템플릿은 콘솔 편의 기능이다. 발송 API 는 템플릿을 모르고, 채워진 `data` 만 받는다.
 */

export type TemplateField = { key: string; label?: string; default?: string; required?: boolean };

/**
 * 커스텀 필드로 쓸 수 없는 키.
 * - 우리가 싣는 키: 덮어쓰면 딥링크·클릭 추적·웹 알림 표시가 깨진다
 * - FCM 예약 키: 넣으면 발송 자체가 거부된다
 */
const RESERVED_KEYS = new Set(["deep_link", "notikit_log_id", "title", "body", "icon", "image", "from", "notification", "message_type", "collapse_key"]);
const RESERVED_PREFIXES = ["google.", "gcm."];

/** 대소문자·유니코드 호환 문자(전각 등)로 예약 키를 우회하지 못하게 비교 전에 맞춘다. */
function normalizeKey(key: string): string {
  return key.normalize("NFKC").toLowerCase();
}

export function isReservedKey(key: string): boolean {
  const k = normalizeKey(key);
  return RESERVED_KEYS.has(k) || RESERVED_PREFIXES.some((p) => k.startsWith(p));
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export const MAX_TEMPLATE_FIELDS = 30;

export const templateFieldSchema = z.object({
  key: z
    .string()
    .regex(KEY_PATTERN, "field key must start with a letter or _ and use letters, digits, _ . -")
    .refine((k) => !isReservedKey(k), "field key is reserved by the push payload"),
  label: z.string().max(60).optional(),
  default: z.string().max(500).optional(),
  required: z.boolean().optional(),
});

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  title: z.string().max(255),
  body: z.string().max(4000),
  deep_link: z.string().url().max(2048).nullable().optional(),
  fields: z
    .array(templateFieldSchema)
    .max(MAX_TEMPLATE_FIELDS)
    .default([])
    .refine((f) => new Set(f.map((x) => x.key)).size === f.length, "field keys must be unique"),
});

export type TemplateInput = z.infer<typeof templateSchema>;

/**
 * 입력값 → 푸시 `data`. 빈 값은 기본값으로, 기본값도 없으면 뺀다.
 * 필수인데 끝내 비면 발송하지 않도록 누락 목록을 돌려준다.
 */
export function buildCustomData(
  fields: TemplateField[],
  values: Record<string, string>
): { data: Record<string, string> | undefined } | { missing: string[] } {
  const data: Record<string, string> = {};
  const missing: string[] = [];
  for (const f of fields) {
    const v = (values[f.key] ?? "").trim() || (f.default ?? "").trim();
    if (v) data[f.key] = v;
    else if (f.required) missing.push(f.key);
  }
  if (missing.length) return { missing };
  return { data: Object.keys(data).length ? data : undefined };
}

/** 발송 화면의 자유 필드 키 검사 — 템플릿 필드와 같은 규칙. 통과하면 null. */
export function fieldKeyError(key: string): string | null {
  const r = templateFieldSchema.shape.key.safeParse(key);
  return r.success ? null : (r.error.issues[0]?.message ?? "invalid key");
}

type StoredTemplate = { title: string; body: string; deepLink: string | null; fields: TemplateField[] };
type TemplateRequest = {
  title?: string;
  body?: string;
  deep_link?: string;
  data?: Record<string, unknown>;
  fields?: Record<string, string>;
};

/**
 * API 발송에 템플릿 적용 — 요청에 직접 준 값이 템플릿보다 우선한다.
 * `fields` 는 템플릿이 정의한 키만 받는다. 오타 난 키를 조용히 버리면 앱이 값을 못 받고도 발송은 성공한다.
 */
export function applyTemplate(
  tpl: StoredTemplate,
  req: TemplateRequest
): { title: string; body: string; deep_link?: string; data?: Record<string, unknown> } | { error: string } {
  const known = new Set(tpl.fields.map((f) => f.key));
  const unknown = Object.keys(req.fields ?? {}).filter((k) => !known.has(k));
  if (unknown.length) return { error: `unknown template fields: ${unknown.join(", ")}` };

  const built = buildCustomData(tpl.fields, req.fields ?? {});
  if ("missing" in built) return { error: `missing required template fields: ${built.missing.join(", ")}` };

  const data = { ...built.data, ...req.data };
  const deepLink = req.deep_link ?? tpl.deepLink ?? undefined;
  return {
    title: req.title || tpl.title,
    body: req.body || tpl.body,
    ...(deepLink ? { deep_link: deepLink } : {}),
    ...(Object.keys(data).length ? { data } : {}),
  };
}
