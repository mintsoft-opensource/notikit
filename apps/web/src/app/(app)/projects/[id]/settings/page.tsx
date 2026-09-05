import { ProjectSettings } from "@/components/console/project-settings";

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ProjectSettings projectId={id} />;
}
