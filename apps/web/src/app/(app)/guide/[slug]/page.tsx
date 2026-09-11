import { notFound } from "next/navigation";
import { listDocs, readDoc } from "@/lib/docs";
import { DocFrame } from "@/components/console/doc-frame";

export async function generateStaticParams() {
  return (await listDocs()).map((d) => ({ slug: d.slug }));
}

export default async function GuideDoc({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = await readDoc(slug);
  if (!doc) notFound();
  return <DocFrame slug={doc.slug} title={doc.title} />;
}
