import type { DecisionEvidenceWindow, TruthSource } from "../types";

export function formatReasonNumber(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export function comparisonLabel(truthSource: TruthSource): string {
  switch (truthSource) {
    case "commercial_truth":
      return "commercial target";
    case "commercial_truth_stale":
      return "commercial target with unavailable timestamp";
    case "account_baseline":
      return "account P75 baseline";
    case "account_baseline_thin":
      return "account P60 baseline";
    case "global_default":
      return "fallback benchmark";
  }
}

/** Calendar days `from`..`to` inclusive, for provider-local `YYYY-MM-DD`. */
function inclusiveDaySpan(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

function periodLabel(
  fallback: string,
  startDate: string,
  endDate: string,
  fullStartDate: string,
  fullEndDate: string,
): string {
  if (startDate === fullStartDate && endDate === fullEndDate) return fallback;
  return `${inclusiveDaySpan(startDate, endDate)}d ${startDate}..${endDate}`;
}

/**
 * The period a decision's CUMULATIVE figures cover, for reason text (ADR D107;
 * D098: a user-facing period label reads the admitted window).
 *
 * "28d" only when the figures really span the full 28-day lookback — which is
 * also what every input without an admitted window (legacy creative inputs,
 * fixtures) sums, so their text is byte-identical. Otherwise the admitted run
 * is named with its day count, start and end: "2d 2026-09-22..2026-09-23".
 */
export function cumulativePeriodLabel(input: {
  decisionWindow?: DecisionEvidenceWindow | null;
}): string {
  const window = input.decisionWindow;
  if (!window) return "28d";
  return periodLabel(
    "28d",
    window.startDate,
    window.endDate,
    window.lookbackStartDate,
    window.lookbackEndDate,
  );
}

/**
 * The period a decision's RECENT figures cover: the last seven lookback days
 * clipped to the admitted run. "7d" when nothing was clipped (or when the run
 * does not reach the band at all, so no recent figure exists to label).
 */
export function recentPeriodLabel(input: {
  decisionWindow?: DecisionEvidenceWindow | null;
}): string {
  const window = input.decisionWindow;
  if (!window || !window.recentStartDate || !window.recentEndDate) return "7d";
  const bandStart = recentBandStartDate(window);
  if (bandStart === null) return "7d";
  return periodLabel(
    "7d",
    window.recentStartDate,
    window.recentEndDate,
    bandStart,
    window.lookbackEndDate,
  );
}

/** First day of the conventional 7-day recent band the window's lookback ends. */
export function recentBandStartDate(
  window: Pick<DecisionEvidenceWindow, "lookbackEndDate">,
): string | null {
  const startMs =
    Date.parse(`${window.lookbackEndDate}T00:00:00Z`) - 6 * 86_400_000;
  return Number.isFinite(startMs)
    ? new Date(startMs).toISOString().slice(0, 10)
    : null;
}
