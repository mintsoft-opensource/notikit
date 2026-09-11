import { redirect } from "next/navigation";
import { listDocs } from "@/lib/docs";

/** 첫 문서로 보낸다 — 어떤 파일이 첫 번째인지 코드가 알 필요는 없다. */
export default async function GuideIndex() {
  const docs = await listDocs();
  redirect(`/guide/${docs[0]?.slug ?? ""}`);
}
