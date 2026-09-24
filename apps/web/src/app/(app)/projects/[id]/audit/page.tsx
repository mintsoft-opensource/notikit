import { AuditConsole } from "@/components/console/audit-console";

export default async function ProjectAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AuditConsole projectId={id} />;
}
