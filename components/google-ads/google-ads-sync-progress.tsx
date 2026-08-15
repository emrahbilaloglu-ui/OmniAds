"use client";

import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import {
  resolveGoogleAdsSyncProgress,
  shouldRenderGoogleAdsSyncProgress,
  type GoogleAdsSyncProgressVariant,
} from "@/lib/google-ads/sync-progress-ux";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";

export { shouldRenderGoogleAdsSyncProgress } from "@/lib/google-ads/sync-progress-ux";

// `freshness` joined the resolver after this component was written; it is a
// backfill-shaped run, so it reads with the same neutral tone as historical.
function getTone(kind: "advisor" | "historical" | "freshness") {
  if (kind === "historical" || kind === "freshness") {
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

export function GoogleAdsSyncProgressSkeleton({
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
          "inline-flex min-w-[170px] max-w-[320px] items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5",
          className
        )}
      >
        <Skeleton className="h-4 w-10 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton className="h-3 w-36 rounded-md" />
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
          <div className="min-w-0 flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-36 rounded-md" />
            <Skeleton className="h-6 w-full rounded-md" />
          </div>
          <Skeleton className="h-3.5 w-10 rounded-md" />
        </div>
        <div className="mt-3 space-y-2">
          <Skeleton className="h-1.5 w-full rounded-full" />
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
        <Skeleton className="h-3 w-44 rounded-md" />
      </div>
    </div>
  );
}

export function GoogleAdsSyncProgress({
  status,
  variant = "default",
  className,
}: {
  status: GoogleAdsStatusResponse | undefined | null;
  variant?: GoogleAdsSyncProgressVariant;
  className?: string;
}) {
  const resolved = resolveGoogleAdsSyncProgress(status, variant);
  if (!resolved) return null;

  const tone = getTone(resolved.kind);
  const progress = resolved.percent;
  const title = resolved.title;
  const description = resolved.description;

  if (variant === "inline") {
    return (
      <div
        className={cn(
          resolved.kind === "historical"
            ? "inline-flex min-w-[150px] max-w-[250px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]"
            : "inline-flex min-w-[170px] max-w-[320px] items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px]",
          tone.border,
          tone.bg,
          tone.detail,
          className
        )}
      >
        <span className="shrink-0 text-[11px] font-semibold tabular-nums">{progress}%</span>
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="truncate leading-none">{description}</div>
          <div className={cn("mt-1 h-1 overflow-hidden rounded-full", tone.track)}>
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
            <p className={cn("mt-1 line-clamp-2 text-[11px] leading-4", tone.subtext)}>
              {description}
            </p>
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
        "rounded-xl border p-4",
        tone.border,
        tone.bg,
        tone.text,
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{title}</p>
          <p className={cn("mt-0.5 text-sm", tone.subtext)}>{description}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn("text-lg font-semibold tabular-nums", tone.text)}>{progress}%</p>
        </div>
      </div>
      <div className={cn("mt-3 h-2 overflow-hidden rounded-full", tone.track)}>
        <div
          className={cn("h-full rounded-full transition-[width] duration-300", tone.fill)}
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className={cn("mt-2 text-xs", tone.subtext)}>{description}</p>
    </div>
  );
}
