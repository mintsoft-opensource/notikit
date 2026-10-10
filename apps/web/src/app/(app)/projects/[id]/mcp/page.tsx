import { McpConsole } from "@/components/console/mcp-console";

export default async function ProjectMcpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <McpConsole projectId={id} />;
}
