import type { CompareMode } from "@/lib/google-ads/reporting-core";

/**
 * What the comparison picker may offer, and what each choice actually computes.
 *
 * The picker offered eight comparisons. The dashboard turned every non-"none"
 * choice into `previous_period`:
 *
 *     const compareMode = preset === "none" ? "none" : "previous_period";
 *
 * So an operator who picked "Previous year" got a previous-*period* delta. Not
 * a missing feature — a wrong number, presented as the one they asked for, with
 * no way to tell. Four of the eight had no server implementation at all, and
 * two that did (`previous_year`, `custom`) were being discarded on the way.
 *
 * This module is the single place the two sides agree. A preset exists here
 * only if `getComparisonWindow` genuinely computes it, so the picker cannot
 * drift back into offering choices nothing honours.
 *
 * Removed, with the reason: `previousWeek`, `previousMonth`, `previousQuarter`
 * and `previousYearMatch` have no comparison window implementation. Offering a
 * choice that silently resolves to a different one is worse than not offering
 * it, so they are gone from the picker rather than quietly aliased. Adding any
 * of them back means implementing its window first — this contract will fail
 * the day the two lists disagree.
 */
export type SupportedComparisonPreset =
  | "none"
  | "custom"
  | "previousPeriod"
  | "previousYear";

/** The preset the operator picked, mapped to what the server will compute. */
export const COMPARISON_PRESET_TO_COMPARE_MODE: Record<
  SupportedComparisonPreset,
  CompareMode
> = {
  none: "none",
  custom: "custom",
  previousPeriod: "previous_period",
  previousYear: "previous_year",
};

/**
 * Resolve a picker preset to a compare mode.
 *
 * An unrecognised preset resolves to `none` rather than to `previous_period`.
 * That is deliberate: a stored saved view or a hand-edited URL carrying a
 * retired preset must show no comparison rather than a confident delta against
 * a baseline the operator never chose.
 */
export function compareModeForPreset(
  preset: string | null | undefined,
): CompareMode {
  if (!preset) return "none";
  return (
    COMPARISON_PRESET_TO_COMPARE_MODE[preset as SupportedComparisonPreset] ??
    "none"
  );
}

/**
 * A custom comparison needs both ends. Without them there is no baseline, and
 * falling back to previous-period would be the original substitution again.
 */
export function customComparisonIsComplete(input: {
  comparisonStart?: string | null;
  comparisonEnd?: string | null;
}): boolean {
  return Boolean(input.comparisonStart && input.comparisonEnd);
}

/**
 * The comparisons the Overview route can carry.
 *
 * `lib/overview-summary-support.ts` types its compare mode as
 * `"none" | "previous_period"`, and the route resolves exactly one baseline
 * window. Offering more here would put a year-over-year label on a
 * previous-period delta, which is the defect this module exists to remove.
 *
 * Narrowing per surface rather than globally, because the Google surface
 * genuinely computes all four and should keep offering them.
 */
export const OVERVIEW_COMPARISON_PRESETS = [
  "none",
  "previousPeriod",
] as const satisfies ReadonlyArray<SupportedComparisonPreset>;
