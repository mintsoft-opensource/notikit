import { SendConsole } from "@/components/console/send-console";

export default async function ProjectSendSinglePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const { id } = await params;
  const { template } = await searchParams;
  return <SendConsole projectId={id} type="single" initialTemplateId={typeof template === "string" ? template : undefined} />;
}
