import { SendConsole } from "@/components/console/send-console";

export default async function ProjectSendTopicPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ target?: string | string[] }>;
}) {
  const { id } = await params;
  const { target } = await searchParams;
  return <SendConsole projectId={id} type="topic" initialTarget={typeof target === "string" ? target : ""} />;
}
