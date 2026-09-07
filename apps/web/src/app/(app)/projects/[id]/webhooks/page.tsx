import { WebhooksConsole } from "@/components/console/webhooks-console";

export default async function ProjectWebhooksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <WebhooksConsole projectId={id} />;
}
