import { UsersConsole } from "@/components/console/users-console";

export default async function ProjectUsersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <UsersConsole projectId={id} />;
}
