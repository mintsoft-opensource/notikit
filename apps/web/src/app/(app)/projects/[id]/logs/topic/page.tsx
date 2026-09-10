import { LogsConsole } from "@/components/console/logs-console";

export default async function ProjectLogsTopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LogsConsole projectId={id} filter="topic" />;
}
