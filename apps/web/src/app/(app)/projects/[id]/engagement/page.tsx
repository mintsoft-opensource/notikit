import { EngagementConsole } from "@/components/console/engagement-console";

export default async function ProjectEngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EngagementConsole projectId={id} />;
}
