"use client";

import { readFreshness } from "@/lib/data-freshness";

/**
 * States how old a surface's data is, and offers to refresh it.
 *
 * Deliberately renders something in every case, including when the age cannot
 * be established: silence would read as "current".
 */
export function FreshnessChip({
  asOf,
  onRefresh,
  refreshing = false,
  className = "",
}: {
  asOf: string | Date | null | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
}) {
  const reading = readFreshness(asOf);

  const tone =
    reading.level === "stale"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : reading.level === "unknown"
        ? "border-neutral-200 bg-neutral-50 text-neutral-600"
        : "border-neutral-200 bg-white text-neutral-600";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] ${tone} ${className}`}
      title={reading.description}
    >
      <span className="tabular-nums">
        {reading.ageLabel ? `as of ${reading.ageLabel}` : "age unknown"}
      </span>
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          className="font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60"
        >
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      ) : null}
    </span>
  );
}
