import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Notikit — 유저 중심 푸시 툴킷",
  description: "오픈소스 · 셀프호스트 가능 · 유저 중심 푸시 알림 인프라",
};

const darkModeFlashGuard = `try{var t=localStorage.getItem('theme');var d=t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');}catch(_){}`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: darkModeFlashGuard }} />
      </head>
      <body className="min-h-full bg-background-alt text-foreground">
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
