"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import type { Project } from "@/lib/admin-client";

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
    <Select aria-label="프로젝트 선택" value={value} onChange={(e) => onChange(e.target.value)} className="w-full sm:w-72">
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
