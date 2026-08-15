"use client";

import type { MetaStatusResponse } from "@/lib/meta/status-types";
import {
  getMetaSyncCaption,
  getMetaSyncDescription,
  getMetaSyncTitle,
} from "@/lib/meta/ui";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export function shouldRenderMetaSyncProgress(
  status: MetaStatusResponse | undefined | null
) {
  if (!status || !status.connected) return false;
  const hasAssignment = (status.assignedAccountIds?.length ?? 0) > 0;
  if (!hasAssignment) return false;
  const progress = status.latestSync?.progressPercent;
  const warehouseRowCount = status.warehouse?.rowCount ?? 0;
  const pendingSurfaces = status.warehouse?.coverage?.pendingSurfaces ?? [];
  const queueDepth = status.jobHealth?.queueDepth ?? 0;
  const leasedPartitions = status.jobHealth?.leasedPartitions ?? 0;
  const retryableFailedPartitions = status.jobHealth?.retryableFailedPartitions ?? 0;
  const historicalCoverage = status.warehouse?.coverage?.historical ?? null;
  const historicalBacklog =
    Boolean(historicalCoverage) &&
    (historicalCoverage?.completedDays ?? 0) < (historicalCoverage?.totalDays ?? 0);
  const selectedRangeCoverage = status.warehouse?.coverage?.selectedRange ?? null;
  const selectedRangePreparing =
    Boolean(selectedRangeCoverage) && !Boolean(selectedRangeCoverage?.isComplete);
  const hasStartedWarehouseBootstrap =
    warehouseRowCount === 0 ||
    pendingSurfaces.length > 0 ||
    historicalBacklog ||
    selectedRangePreparing ||
    queueDepth > 0 ||
    leasedPartitions > 0 ||
    retryableFailedPartitions > 0 ||
    status.state === "syncing" ||
    status.state === "partial" ||
    status.latestSync?.status === "pending" ||
    status.latestSync?.status === "running" ||
    status.needsBootstrap;
  return Boolean(
    hasStartedWarehouseBootstrap ||
      (typeof progress === "number" && progress < 100) ||
      status.state === "action_required" ||
      status.state === "paused" ||
      status.state === "stale"
  );
}

function getTone(status: MetaStatusResponse) {
  if (status.state === "action_required") {
    return {
      border: "border-[var(--adc-caution-bd)]",
      bg: "bg-[var(--adc-caution-bg)]",
      track: "bg-[var(--adc-caution-bg)]",
      fill: "bg-[var(--adc-caution-fg)]",
      text: "text-[var(--adc-caution-fg)]",
      subtext: "text-[var(--adc-caution-fg)]/85",
      detail: "text-[var(--adc-caution-fg)]/90",
    };
  }
  if (status.state === "paused") {
    return {
      border: "border-slate-200",
      bg: "bg-slate-50",
      track: "bg-slate-200",
      fill: "bg-slate-500",
      text: "text-slate-900",
      subtext: "text-slate-700/85",
      detail: "text-slate-800/90",
    };
  }
  if (status.state === "partial") {
    return {
      border: "border-[var(--adc-info-bd)]",
      bg: "bg-[var(--adc-info-bg)]",
      track: "bg-[var(--adc-info-bg)]",
      fill: "bg-[var(--adc-info-fg)]",
      text: "text-[var(--adc-info-fg)]",
      subtext: "text-[var(--adc-info-fg)]/85",
      detail: "text-[var(--adc-info-fg)]/90",
    };
  }
  return {
    border: "border-[var(--adc-info-bd)]",
    bg: "bg-[var(--adc-info-bg)]",
    track: "bg-[var(--adc-info-bg)]",
    fill: "bg-[var(--adc-info-fg)]",
    text: "text-[var(--adc-info-fg)]",
    subtext: "text-[var(--adc-info-fg)]/85",
    detail: "text-[var(--adc-info-fg)]/90",
  };
}

export function MetaSyncProgressSkeleton({
  variant = "default",
  className,
}: {
  variant?: "default" | "compact" | "inline";
  className?: string;
}) {
  if (variant === "inline") {
    return (
      <div
        className={cn(
          "inline-flex min-w-[240px] items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5",
          className
        )}
      >
        <Skeleton className="h-4 w-10 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3 w-40 rounded-md" />
          <Skeleton className="h-1.5 w-full rounded-full" />
        </div>
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div
        className={cn(
          "rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3",
          className
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <Skeleton className="h-3.5 w-40 rounded-md" />
          <Skeleton className="h-3.5 w-10 rounded-md" />
        </div>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-1.5 w-full rounded-full" />
          <Skeleton className="h-3 w-32 rounded-md" />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border border-slate-200 bg-slate-50 p-4",
        className
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-4 w-44 rounded-md" />
          <Skeleton className="h-3 w-56 rounded-md" />
        </div>
        <Skeleton className="h-6 w-12 rounded-md" />
      </div>
      <div className="mt-4 space-y-2">
        <Skeleton className="h-2 w-full rounded-full" />
        <Skeleton className="h-3 w-36 rounded-md" />
      </div>
    </div>
  );
}

export function MetaSyncProgress({
  status,
  language = "en",
  variant = "default",
  className,
}: {
  status: MetaStatusResponse | undefined | null;
  language?: "en" | "tr";
  variant?: "default" | "compact" | "inline";
  className?: string;
}) {
  if (!shouldRenderMetaSyncProgress(status)) return null;
  const activeStatus = status as MetaStatusResponse;

  const progress = Math.max(
    0,
    Math.min(100, Math.round(activeStatus.latestSync?.progressPercent ?? 0))
  );
  const title = getMetaSyncTitle(activeStatus, language);
  const description = getMetaSyncDescription(activeStatus, language);
  const caption = getMetaSyncCaption(activeStatus, language);
  const tone = getTone(activeStatus);

  if (variant === "inline") {
    return (
      <div
        className={cn(
          "inline-flex min-w-[240px] items-center gap-3 rounded-xl border px-3.5 py-2.5 text-xs",
          tone.border,
          tone.bg,
          tone.detail,
          className
        )}
      >
        <span className="shrink-0 font-semibold tabular-nums">{progress}%</span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="line-clamp-2 text-[11px] font-medium leading-4">{caption ?? description}</div>
          <div className={cn("h-1.5 overflow-hidden rounded-full", tone.track)}>
            <div
              className={cn("h-full rounded-full transition-[width] duration-300", tone.fill)}
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  const compact = variant === "compact";
  if (compact) {
    return (
      <div
        className={cn(
          "rounded-xl border px-3.5 py-3",
          tone.border,
          tone.bg,
          tone.text,
          className
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold">{title}</p>
            <p className={cn("mt-1 line-clamp-2 text-[11px] leading-4", tone.subtext)}>{caption ?? description}</p>
          </div>
          <p className="shrink-0 text-xs font-semibold tabular-nums">{progress}%</p>
        </div>
        <div className={cn("mt-3 h-1.5 overflow-hidden rounded-full", tone.track)}>
          <div
            className={cn("h-full rounded-full transition-[width] duration-300", tone.fill)}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "rounded-xl border",
        tone.border,
        tone.bg,
        tone.text,
        "p-4",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className={cn("font-semibold", compact ? "text-sm" : "text-sm")}>{title}</p>
          <p className={cn("mt-1 text-sm", tone.subtext)}>
            {description}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("font-semibold tabular-nums", compact ? "text-sm" : "text-lg")}>
            {progress}%
          </p>
        </div>
      </div>
      <div className={cn("mt-4 h-2 overflow-hidden rounded-full", tone.track)}>
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", tone.fill)}
          style={{ width: `${progress}%` }}
        />
      </div>
      {caption ? (
        <p className={cn("mt-3 text-xs", tone.detail)}>{caption}</p>
      ) : null}
      {activeStatus.latestSync?.lastError &&
      (activeStatus.state === "partial" || activeStatus.state === "action_required") ? (
        <p className={cn("mt-2 text-xs", tone.detail)}>
          {activeStatus.latestSync.lastError}
        </p>
      ) : null}
    </div>
  );
}
