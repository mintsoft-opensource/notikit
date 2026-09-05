import { createPrivateKey } from "node:crypto";
import { z } from "zod";

/** Firebase 서비스 계정 JSON 스키마 (핵심 필드만 검증) */
export const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  project_id: z.string().min(1),
  private_key: z.string().min(1),
  client_email: z.string().email(),
});

export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

/** private_key 가 실제 파싱 가능한 PEM 인지 검증 (사용 불가한 키가 정상 키를 덮어쓰는 것 방지) */
function assertUsablePrivateKey(pem: string): void {
  const normalized = pem.replace(/\\n/g, "\n"); // JSON 이스케이프된 개행 복원
  try {
    createPrivateKey(normalized);
  } catch {
    throw new Error("private_key 가 유효한 PEM 개인키가 아닙니다");
  }
}

/** 업로드된 값(문자열/객체)을 검증된 서비스 계정으로 파싱. 실패 시 에러 메시지 throw. */
export function parseServiceAccount(input: unknown): ServiceAccount {
  const obj = typeof input === "string" ? JSON.parse(input) : input;
  const parsed = serviceAccountSchema.safeParse(obj);
  if (!parsed.success) {
    throw new Error("유효한 Firebase 서비스 계정 JSON 이 아닙니다 (type/project_id/private_key/client_email 필요)");
  }
  assertUsablePrivateKey(parsed.data.private_key);
  return parsed.data;
}
