"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { SyncStatusPillState } from "@/lib/sync/sync-status-pill";
import { cn } from "@/lib/utils";

const toneClasses: Record<SyncStatusPillState["tone"], string> = {
  info: "border-sky-200 bg-sky-50 text-sky-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
};

export function SyncStatusPill({
  pill,
  className,
}: {
  pill: SyncStatusPillState | null | undefined;
  className?: string;
}) {
  if (!pill?.visible) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold leading-none",
        toneClasses[pill.tone],
        className
      )}
    >
      {pill.label}
    </span>
  );
}

export function SyncStatusPillSkeleton({ className }: { className?: string }) {
  return <Skeleton className={cn("h-6 w-24 rounded-full", className)} />;
}
