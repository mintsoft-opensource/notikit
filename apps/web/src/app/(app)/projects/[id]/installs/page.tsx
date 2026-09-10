import { InstallsConsole } from "@/components/console/installs-console";

export default async function ProjectInstallsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InstallsConsole projectId={id} />;
}
