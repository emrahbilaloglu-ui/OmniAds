"use client";

import { FreshnessChip } from "@/components/states/FreshnessChip";
import type { ProductInstrumentationSurface } from "@/lib/product-instrumentation";

/**
 * One freshness contract for every Tier-0 data surface.
 *
 * The surfaces disagreed about how to say "here is how old this is". Some said
 * nothing, which reads as current; some showed a spinner that became a zero;
 * some failed and left the last good numbers on screen with no sign anything
 * had gone wrong. An operator cannot calibrate trust against a rule that
 * changes per page.
 *
 * The states are the honest ones and nothing else:
 *
 * - **loading** — we do not know yet. It must never render a number, because a
 *   zero during load is indistinguishable from a real zero and people act on it.
 * - **refreshing** — we have data and are checking for newer. The existing
 *   numbers stay, labelled as the ones being replaced.
 * - **fresh / stale** — we know the age. Stale says so rather than staying quiet.
 * - **partial** — some of it arrived. Says which part is missing rather than
 *   presenting an incomplete total as complete.
 * - **error** — a terminal failure, named, with a retry that actually retries.
 *   Never a silent fallback to older data dressed as current.
 */
export type TierZeroFreshnessState =
  | "loading"
  | "refreshing"
  | "ready"
  | "partial"
  | "error";

/** A short, absolute label for a last-good reading. Never "just now". */
function formatAsOfLabel(asOf: string | Date | null | undefined): string {
  if (!asOf) return "an earlier reading";
  const parsed = asOf instanceof Date ? asOf : new Date(asOf);
  if (Number.isNaN(parsed.getTime())) return "an earlier reading";
  return `data from ${parsed.toLocaleString()}`;
}

export function TierZeroFreshness({
  state,
  asOf,
  onRetry,
  errorCode = null,
  partialReason = null,
  businessId = null,
  surface,
  className = "",
}: {
  state: TierZeroFreshnessState;
  asOf: string | Date | null | undefined;
  onRetry?: () => void;
  /** A bounded code, never a raw provider message. */
  errorCode?: string | null;
  partialReason?: string | null;
  businessId?: string | null;
  surface: ProductInstrumentationSurface;
  className?: string;
}) {
  if (state === "loading") {
    return (
      <span
        data-freshness-state="loading"
        aria-live="polite"
        className={`text-[12px] text-[var(--adc-ink3,#7d838c)] ${className}`}
      >
        Loading — no figures yet
      </span>
    );
  }

  if (state === "error") {
    // The wording distinguishes the two error cases, because they are not the
    // same to the reader.
    //
    // This component reports; it cannot withhold anything. React Query keeps
    // the last good payload through a failed revalidation, so on a surface
    // that still renders those numbers, "figures withheld" was simply false --
    // and worse, it told the operator not to trust figures that were fine,
    // while saying nothing about how old they were. When there is a last-good
    // as-of, the reading names it. Only when there is nothing on screen does it
    // say the figures are withheld.
    const hasLastGood = Boolean(asOf);
    return (
      <span
        data-freshness-state="error"
        data-freshness-error={errorCode ?? "unknown"}
        data-freshness-last-good={hasLastGood ? "shown" : "none"}
        role="status"
        className={`inline-flex items-center gap-2 text-[12px] text-rose-700 ${className}`}
      >
        <span>
          {hasLastGood
            ? `Could not refresh — showing ${formatAsOfLabel(asOf)}`
            : "Could not load — figures withheld"}
        </span>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded border border-rose-300 px-1.5 py-0.5 text-[12px] font-medium"
          >
            Try again
          </button>
        ) : null}
      </span>
    );
  }

  return (
    <span
      data-freshness-state={state}
      className={`inline-flex items-center gap-2 ${className}`}
    >
      <FreshnessChip
        asOf={asOf}
        onRefresh={onRetry}
        refreshing={state === "refreshing"}
        businessId={businessId}
        surface={surface}
      />
      {state === "partial" ? (
        <span
          data-freshness-partial="true"
          role="status"
          className="text-[12px] text-amber-700"
        >
          {partialReason ?? "Some sources are missing; totals are incomplete"}
        </span>
      ) : null}
    </span>
  );
}
