import { DevicesConsole } from "@/components/console/devices-console";

export default async function ProjectDevicesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DevicesConsole projectId={id} />;
}
