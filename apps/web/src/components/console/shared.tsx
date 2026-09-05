"use client";

import * as React from "react";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import type { Project } from "@/lib/admin-client";

export function TokenRequired() {
  return (
    <Card className="flex flex-col items-center gap-3 p-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent-soft text-primary">
        <KeyRound className="h-6 w-6" />
      </span>
      <div>
        <p className="text-base font-bold">관리자 토큰이 필요합니다</p>
        <p className="mt-1 text-sm text-muted-foreground">설정에서 admin token 을 입력하면 콘솔을 사용할 수 있습니다.</p>
      </div>
      <Link
        href="/settings"
        className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        설정으로 이동
      </Link>
    </Card>
  );
}

export function StatCard({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-extrabold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full sm:w-72">
      <option value="">프로젝트 선택…</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({p.environment})
        </option>
      ))}
    </Select>
  );
}

export function ErrorText({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return <p className="rounded-md bg-error/10 px-3 py-2 text-xs text-error">{children}</p>;
}
