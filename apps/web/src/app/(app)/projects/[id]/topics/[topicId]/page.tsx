import { TopicDetail } from "@/components/console/topic-detail";

export default async function TopicDetailPage({
  params,
}: {
  params: Promise<{ id: string; topicId: string }>;
}) {
  const { id, topicId } = await params;
  return <TopicDetail projectId={id} topicId={topicId} />;
}
