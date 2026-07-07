"use client";

import { Skeleton } from "@/components/ui/skeleton";

export function MetricLoadingCard() {
  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-5">
      <Skeleton className="h-3 w-16" />
      <Skeleton className="mt-3 h-9 w-28" />
      <Skeleton className="mt-4 h-4 w-36" />
    </article>
  );
}
