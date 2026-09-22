import { SendConsole } from "@/components/console/send-console";

export default async function ProjectSendBroadcastPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SendConsole projectId={id} type="broadcast" />;
}
