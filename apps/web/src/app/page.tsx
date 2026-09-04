import { Bell, Send, Users, Layers, Webhook } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const features = [
  { icon: Users, title: "유저 중심 identity", desc: "토큰이 아니라 유저·계정 단위 발송, 다중 기기 연결" },
  { icon: Layers, title: "멀티테넌트", desc: "프로젝트별 Firebase 자격증명 격리·암호화" },
  { icon: Send, title: "멀티플랫폼 SDK", desc: "Web · WebView · Android · Swift · Flutter · RN" },
  { icon: Webhook, title: "셀프호스트", desc: "docker compose 한 방, 데이터 주권" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <header className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Bell className="h-5 w-5" />
        </span>
        <div>
          <h1 className="text-xl font-bold tracking-tight">Notikit</h1>
          <p className="text-sm text-muted-foreground">유저 중심 푸시 툴킷</p>
        </div>
      </header>

      <section className="mt-12">
        <h2 className="text-3xl font-bold tracking-tight">
          FCM 위에 <span className="text-primary">사용자·계정 레이어</span>를 얹다
        </h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">
          오픈소스 · 셀프호스트 가능한 유저 중심 푸시 인프라. 토큰이 아니라 사람에게 도달합니다.
        </p>
        <div className="mt-6 flex gap-3">
          <Button size="lg" asChild>
            <a href="/dashboard">대시보드 시작</a>
          </Button>
          <Button size="lg" variant="outline" asChild>
            <a href="/docs">API 문서</a>
          </Button>
        </div>
      </section>

      <section className="mt-14 grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <Card key={f.title}>
            <CardHeader>
              <span className="flex h-9 w-9 items-center justify-center rounded-md bg-surface-muted text-primary">
                <f.icon className="h-4 w-4" />
              </span>
              <CardTitle>{f.title}</CardTitle>
              <CardDescription>{f.desc}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>

      <footer className="mt-16 border-t border-border pt-6 text-sm text-muted-foreground">
        Notikit · Apache-2.0 · MintSoft ·{" "}
        <a className="text-primary hover:underline" href="/api/health">health</a>
      </footer>
    </main>
  );
}
