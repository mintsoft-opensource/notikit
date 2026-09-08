"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { Select } from "@/components/ui/input";
import type { Project } from "@/lib/admin-client";

export function ProjectPicker({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string;
  onChange: (id: string) => void;
}) {
  const t = useTranslations("common");
  return (
    <Select aria-label={t("selectProject")} value={value} onChange={(e) => onChange(e.target.value)} className="w-full sm:w-72">
      <option value="">{t("selectProjectPlaceholder")}</option>
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
