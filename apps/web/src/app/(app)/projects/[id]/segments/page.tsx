import { SegmentsConsole } from "@/components/console/segments-console";

export default async function ProjectSegmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SegmentsConsole projectId={id} />;
}
