"use client";

import { useEffect, useRef } from "react";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import type { ProductInstrumentationSurface } from "@/lib/product-instrumentation";
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
  businessId = null,
  surface = "meta_decisions",
}: {
  asOf: string | Date | null | undefined;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
  /** Present when the chip belongs to one client's data. */
  businessId?: string | null;
  surface?: ProductInstrumentationSurface;
}) {
  const reading = readFreshness(asOf);

  // Section 9: how often an operator is actually shown stale data. Emitted once
  // per mount of a stale or unknown reading rather than on every render, so the
  // count is "times disclosed", not "times re-rendered".
  const disclosed = useRef(false);
  useEffect(() => {
    if (disclosed.current) return;
    if (reading.level !== "stale" && reading.level !== "unknown") return;
    disclosed.current = true;
    emitProductInstrumentation({
      eventName: "freshness_stale_disclosed",
      surface,
      outcome: "withheld",
      scope: businessId ? "business" : "portfolio",
      businessId,
    });
  }, [reading.level, businessId, surface]);

  const tone =
    reading.level === "stale"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : reading.level === "unknown"
        ? "border-neutral-200 bg-neutral-50 text-neutral-600"
        : "border-neutral-200 bg-white text-neutral-600";

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[12px] ${tone} ${className}`}
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
          // A bare text link measured 43x17 on a phone. Underlined text is the
          // right visual weight here -- it should not become a button -- so the
          // target is grown with padding and a min-height rather than by making
          // the label bigger, which would shout over the reading it sits beside.
          className="inline-flex min-h-[24px] items-center px-1 font-semibold underline underline-offset-2 disabled:no-underline disabled:opacity-60"
        >
          {refreshing ? "Refreshing" : "Refresh"}
        </button>
      ) : null}
    </span>
  );
}
