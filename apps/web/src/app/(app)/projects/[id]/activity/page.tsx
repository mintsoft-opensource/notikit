import { ActivityConsole } from "@/components/console/activity-console";

export default async function ProjectActivityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ActivityConsole projectId={id} />;
}
