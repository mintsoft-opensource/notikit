import { SuppressionsConsole } from "@/components/console/suppressions-console";

export default async function ProjectSuppressionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SuppressionsConsole projectId={id} />;
}
