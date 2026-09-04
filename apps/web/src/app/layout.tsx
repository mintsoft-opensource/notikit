import type { Metadata } from "next";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notikit — 유저 중심 푸시 툴킷",
  description: "오픈소스 · 셀프호스트 가능 · 유저 중심 푸시 알림 인프라",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
