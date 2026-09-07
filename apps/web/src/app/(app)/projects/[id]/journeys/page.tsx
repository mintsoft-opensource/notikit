import { JourneysConsole } from "@/components/console/journeys-console";

export default async function ProjectJourneysPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JourneysConsole projectId={id} />;
}
