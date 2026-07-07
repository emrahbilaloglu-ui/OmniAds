"use client";

import { useRouter } from "next/navigation";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IntegrationStatus } from "@/store/integrations-store";

interface IntegrationEmptyStateProps {
  providerLabel: string;
  status?: IntegrationStatus;
  title?: string;
  description?: string;
}

export function IntegrationEmptyState({
  providerLabel,
  status,
  title,
  description,
}: IntegrationEmptyStateProps) {
  const router = useRouter();

  const resolvedTitle =
    title ??
    (status === "error" || status === "timeout"
      ? `${providerLabel} connection failed`
      : `Connect ${providerLabel} to unlock campaign performance`);

  const resolvedDescription =
    description ??
    (status === "error" || status === "timeout"
      ? `Your ${providerLabel} connection encountered an issue. Go to Integrations to reconnect.`
      : `View campaigns, ad sets, ads, and creative insights once your ${providerLabel} account is connected.`);

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-neutral-300 bg-white p-8 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50">
        <Plug className="h-5 w-5 text-neutral-500" />
      </div>
      <h3 className="text-base font-semibold tracking-tight text-neutral-950">{resolvedTitle}</h3>
      <p className="mt-2 max-w-sm text-sm leading-5 text-neutral-500">{resolvedDescription}</p>
      <Button className="mt-5 rounded-md" onClick={() => router.push("/integrations")}>
        Open Integrations
      </Button>
    </div>
  );
}
