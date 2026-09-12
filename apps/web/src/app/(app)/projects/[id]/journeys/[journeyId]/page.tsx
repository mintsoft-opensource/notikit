import { JourneyDetail } from "@/components/console/journey-detail";

export default async function JourneyDetailPage({
  params,
}: {
  params: Promise<{ id: string; journeyId: string }>;
}) {
  const { id, journeyId } = await params;
  return <JourneyDetail projectId={id} journeyId={journeyId} />;
}
