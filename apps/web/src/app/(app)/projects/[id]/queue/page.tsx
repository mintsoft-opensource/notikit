import { QueueConsole } from "@/components/console/queue-console";

export default async function ProjectQueuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QueueConsole projectId={id} />;
}
