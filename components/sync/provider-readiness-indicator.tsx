"use client";

import type { ProviderDomainReadiness, ProviderReadinessLevel } from "@/lib/provider-readiness";
import { cn } from "@/lib/utils";

type SourceHealth =
  | "fresh"
  | "healthy_cached"
  | "stale_cached"
  | "degraded_blocking"
  | null
  | undefined;

function getReadinessLabel(
  readinessLevel: ProviderReadinessLevel | null | undefined,
  sourceHealth?: SourceHealth
) {
  if (sourceHealth === "healthy_cached" || sourceHealth === "stale_cached") {
    return "Cached account list in use";
  }
  if (readinessLevel === "ready") return "Data ready";
  if (readinessLevel === "usable") return "Partially ready";
  return "Preparing data";
}

function getTone(
  readinessLevel: ProviderReadinessLevel | null | undefined,
  sourceHealth?: SourceHealth
) {
  if (sourceHealth === "stale_cached") {
    return {
      border: "border-amber-200",
      bg: "bg-amber-50",
      text: "text-amber-900",
      subtext: "text-amber-800/85",
      dot: "bg-amber-500",
    };
  }
  if (sourceHealth === "healthy_cached") {
    return {
      border: "border-sky-200",
      bg: "bg-sky-50",
      text: "text-sky-900",
      subtext: "text-sky-800/85",
      dot: "bg-sky-500",
    };
  }
  if (readinessLevel === "ready") {
    return {
      border: "border-emerald-200",
      bg: "bg-emerald-50",
      text: "text-emerald-900",
      subtext: "text-emerald-800/85",
      dot: "bg-emerald-500",
    };
  }
  if (readinessLevel === "usable") {
    return {
      border: "border-sky-200",
      bg: "bg-sky-50",
      text: "text-sky-900",
      subtext: "text-sky-800/85",
      dot: "bg-sky-500",
    };
  }
  return {
    border: "border-slate-200",
    bg: "bg-slate-50",
    text: "text-slate-900",
    subtext: "text-slate-700/85",
    dot: "bg-slate-500",
  };
}

export function ProviderReadinessIndicator({
  readinessLevel,
  domainReadiness,
  sourceHealth,
  className,
}: {
  readinessLevel?: ProviderReadinessLevel | null;
  domainReadiness?: ProviderDomainReadiness | null;
  sourceHealth?: SourceHealth;
  className?: string;
}) {
  const label = getReadinessLabel(readinessLevel, sourceHealth);
  const summary = domainReadiness?.summary ?? null;
  const tone = getTone(readinessLevel, sourceHealth);

  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-xl border px-3 py-2",
        tone.border,
        tone.bg,
        className
      )}
    >
      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", tone.dot)} />
      <div className="min-w-0">
        <p className={cn("text-xs font-semibold", tone.text)}>{label}</p>
        {summary ? (
          <p className={cn("truncate text-[11px]", tone.subtext)}>{summary}</p>
        ) : null}
      </div>
    </div>
  );
}
