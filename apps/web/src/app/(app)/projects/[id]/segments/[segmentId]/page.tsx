import { SegmentDetail } from "@/components/console/segment-detail";

export default async function SegmentDetailPage({
  params,
}: {
  params: Promise<{ id: string; segmentId: string }>;
}) {
  const { id, segmentId } = await params;
  return <SegmentDetail projectId={id} segmentId={segmentId} />;
}
