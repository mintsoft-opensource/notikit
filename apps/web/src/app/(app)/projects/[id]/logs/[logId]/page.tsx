import { LogDetail } from "@/components/console/log-detail";

export default async function LogDetailPage({
  params,
}: {
  params: Promise<{ id: string; logId: string }>;
}) {
  const { id, logId } = await params;
  return <LogDetail projectId={id} logId={logId} />;
}
