import { TemplatesConsole } from "@/components/console/templates-console";

export default async function ProjectTemplatesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TemplatesConsole projectId={id} />;
}
