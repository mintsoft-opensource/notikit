import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { projects } from "@/db/schema";
import { ok, fail } from "@/lib/api-response";
import { requireProject, checkOrigin } from "@/lib/authz";
import { failAudited, recordAudit } from "@/lib/audit";
import { generateMcpToken, hashMcpToken } from "@/lib/mcp-token";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** [Web Admin] MCP 토큰 상태 — 발급 여부와 발급 시각만. 토큰 원문은 어디에도 남아 있지 않다. */
export async function GET(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  const authz = await requireProject(req, id);
  if (!authz.ok) return fail(authz.error, authz.status);

  const row = (
    await getDb()
      .select({ hash: projects.mcpTokenHash, createdAt: projects.mcpTokenCreatedAt })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1)
  )[0];
  if (!row) return fail("Project not found", 404);
  return ok({ issued: !!row.hash, created_at: row.hash ? row.createdAt : null });
}

/**
 * [Web Admin] MCP 토큰 발급 — 이미 있으면 **교체**한다(이전 토큰은 즉시 무효).
 * 토큰은 프로젝트당 하나다: 여러 개를 두면 "어느 것이 새어 나갔는지" 를 가릴 화면이 따로 필요해진다.
 */
export async function POST(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "mcp_token.create", "project", authz);

  const token = generateMcpToken();
  const createdAt = new Date();
  const updated = await getDb()
    .update(projects)
    .set({ mcpTokenHash: hashMcpToken(token), mcpTokenCreatedAt: createdAt })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  if (updated.length === 0) return fail("Project not found", 404);

  await recordAudit({ projectId: id, actor: authz.ctx, action: "mcp_token.create", targetType: "project", targetId: id, req });
  return ok({ token, created_at: createdAt }, { note: "token is shown once — store it now" }, 201);
}

/** [Web Admin] MCP 토큰 폐기 */
export async function DELETE(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  if (!checkOrigin(req)) return fail("Invalid origin", 403);
  const authz = await requireProject(req, id, { write: true });
  if (!authz.ok) return failAudited(req, id, "mcp_token.delete", "project", authz);

  const updated = await getDb()
    .update(projects)
    .set({ mcpTokenHash: null, mcpTokenCreatedAt: null })
    .where(eq(projects.id, id))
    .returning({ id: projects.id });
  if (updated.length === 0) return fail("Project not found", 404);

  await recordAudit({ projectId: id, actor: authz.ctx, action: "mcp_token.delete", targetType: "project", targetId: id, req });
  return ok({ issued: false });
}
