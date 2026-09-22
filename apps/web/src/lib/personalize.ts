/**
 * 발송 문구 치환 — `{{속성}}` 을 받는 사람의 값으로 바꾼다.
 *
 * - `{{name}}`        : identify 로 보낸 attributes.name
 * - `{{external_id}}` : 사용자 아이디(내장 변수)
 * - `{{name|고객}}`   : 값이 없거나 빈 문자열이면 `고객`
 *
 * 값이 없고 기본값도 없으면 빈 문자열이 된다. 중괄호를 그대로 남기면 받는 사람에게
 * `{{name}}` 이 보이는데, 그건 빈칸보다 나쁘다.
 */

export type Recipient = { externalId: string; attributes: Record<string, unknown> | null } | null;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]{1,64})\s*(?:\|([^}]*))?\}\}/g;

export function hasPlaceholders(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => Boolean(t) && new RegExp(PLACEHOLDER.source).test(t!));
}

function valueOf(recipient: Recipient, key: string): string {
  if (!recipient) return "";
  if (key === "external_id") return recipient.externalId;
  const v = recipient.attributes?.[key];
  // 객체·배열은 문자열로 만들면 "[object Object]" 가 보인다 — 없는 값으로 친다
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

export function renderTemplate(template: string, recipient: Recipient): string {
  return template.replace(PLACEHOLDER, (_, key: string, fallback?: string) => {
    const v = valueOf(recipient, key);
    return v !== "" ? v : (fallback ?? "").trim();
  });
}
