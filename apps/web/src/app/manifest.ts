import type { MetadataRoute } from "next";
import { getTranslations } from "next-intl/server";

/** PWA manifest — 홈 화면 추가 시 아이콘/이름. 이름은 현재 로케일을 따른다. */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = await getTranslations("meta");
  const ta = await getTranslations("app");
  return {
    name: t("title"),
    short_name: ta("name"),
    description: t("description"),
    start_url: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#102b22",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
