import { TopicsConsole } from "@/components/console/topics-console";

export default async function ProjectTopicsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TopicsConsole projectId={id} />;
}
