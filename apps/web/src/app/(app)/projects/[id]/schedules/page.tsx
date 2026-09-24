import { SchedulesConsole } from "@/components/console/schedules-console";

export default async function ProjectSchedulesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SchedulesConsole projectId={id} />;
}
