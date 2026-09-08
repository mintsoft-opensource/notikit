import type { AuthContext } from "@/lib/authz";

export const ROLES = ["owner", "admin", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/**
 * 권한 상승 방지: admin 은 owner 를 만들거나 owner 로 승격시킬 수 없다.
 * (그렇지 않으면 admin 이 owner 계정을 만들어 스스로 최고 권한을 획득한다)
 */
export function canAssignRole(ctx: AuthContext, role: string): boolean {
  return ctx.superadmin || ctx.role === "owner" || role !== "owner";
}
