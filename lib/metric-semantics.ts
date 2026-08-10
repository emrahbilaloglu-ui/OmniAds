/**
 * Shared metric semantics: direction, comparison, and delta sentiment.
 *
 * Two rules from the money/metric truth contract are enforced here rather than
 * in components, because every surface that renders a delta needs the same answer:
 *
 * 1. Compare=None produces no delta and no directional color. A missing comparison
 *    is not a zero comparison, so it must never coerce to `0.0%`.
 * 2. Colour follows business meaning, not arithmetic sign. A cost metric that rose
 *    is a worse outcome even though the number went up.
 */

export type MetricDirection = "higher_is_better" | "lower_is_better" | "neutral";

export type ComparisonMode =
  | "none"
  | "previous_period"
  | "previous_week"
  | "previous_month"
  | "previous_year"
  | "previous_year_weekday_match"
  | "custom";

/** Why a delta cannot be shown. Each reason renders differently from a real zero. */
export type ComparisonUnavailableReason =
  | "no_comparison_mode"
  | "missing_current_value"
  | "missing_baseline_value"
  | "baseline_zero";

export type MetricComparison =
  | { available: false; reason: ComparisonUnavailableReason; basisLabel: string | null }
  | {
      available: true;
      changePercent: number | null;
      changeValue: number | null;
      /** Names what the delta is measured against, e.g. "vs previous period". */
      basisLabel: string;
      /** Business meaning of the change. Drives colour. */
      sentiment: "positive" | "negative" | "neutral";
      /** Arithmetic direction of the change. Drives the arrow glyph only. */
      arrow: "up" | "down" | "flat";
    };

const COMPARISON_BASIS_LABELS: Record<Exclude<ComparisonMode, "none">, string> = {
  previous_period: "vs previous period",
  previous_week: "vs previous week",
  previous_month: "vs previous month",
  previous_year: "vs previous year",
  previous_year_weekday_match: "vs previous year (weekday match)",
  custom: "vs custom baseline",
};

export function comparisonBasisLabel(mode: ComparisonMode): string | null {
  return mode === "none" ? null : COMPARISON_BASIS_LABELS[mode];
}

/**
 * Metric direction registry.
 *
 * Cost and efficiency metrics are lower-is-better. Spend is deliberately neutral:
 * spending more is not by itself good or bad, and colouring it green or red
 * misleads during pacing review.
 */
const LOWER_IS_BETTER = new Set([
  "cpa",
  "cpc",
  "cpm",
  "cpp",
  "cac",
  "costperpurchase",
  "costperresult",
  "costperlead",
  "costperclick",
  "costperacquisition",
  "refunds",
  "refundrate",
  "cancellationrate",
  "bouncerate",
  "frequency",
  "unsubscriberate",
  "spendperorder",
]);

const HIGHER_IS_BETTER = new Set([
  "revenue",
  "roas",
  "roi",
  "mer",
  "amer",
  "aov",
  "purchases",
  "conversions",
  "orders",
  "sessions",
  "clicks",
  "outboundclicks",
  "uniqueclicks",
  "ctr",
  "outboundctr",
  "uniquectr",
  "impressions",
  "reach",
  "landingpageviews",
  "contributionmargin",
  "netprofit",
  "grossprofit",
  "conversionrate",
  "cvr",
  "thumbstop",
  "holdrate",
]);

/** Metrics that are genuinely directionless; listed so they are explicit, not defaults. */
const NEUTRAL = new Set(["spend", "budget", "dailybudget", "amountspent", "cost"]);

function normalizeMetricKey(metricKey: string): string {
  return metricKey.toLowerCase().replace(/[\s_\-.]/g, "");
}

/**
 * Resolve the business direction of a metric.
 *
 * Unknown metrics return "neutral" so an unrecognised key can never be coloured
 * by arithmetic sign alone.
 */
export function getMetricDirection(metricKey: string | null | undefined): MetricDirection {
  if (!metricKey) return "neutral";
  const key = normalizeMetricKey(metricKey);
  if (LOWER_IS_BETTER.has(key)) return "lower_is_better";
  if (HIGHER_IS_BETTER.has(key)) return "higher_is_better";
  if (NEUTRAL.has(key)) return "neutral";
  return "neutral";
}

export function isKnownMetricKey(metricKey: string | null | undefined): boolean {
  if (!metricKey) return false;
  const key = normalizeMetricKey(metricKey);
  return LOWER_IS_BETTER.has(key) || HIGHER_IS_BETTER.has(key) || NEUTRAL.has(key);
}

/**
 * Map an arithmetic change onto business sentiment for a given metric direction.
 * A zero change is always neutral, whatever the direction.
 */
export function deltaSentiment(
  direction: MetricDirection,
  changeValue: number,
): "positive" | "negative" | "neutral" {
  if (!Number.isFinite(changeValue) || changeValue === 0) return "neutral";
  if (direction === "neutral") return "neutral";
  const rose = changeValue > 0;
  if (direction === "higher_is_better") return rose ? "positive" : "negative";
  return rose ? "negative" : "positive";
}

/**
 * Build the comparison a surface may render.
 *
 * Returns an unavailable comparison rather than a zero whenever the comparison
 * mode is none or either side of the comparison is missing.
 */
export function resolveComparison(input: {
  metricKey: string | null | undefined;
  mode: ComparisonMode;
  currentValue: number | null | undefined;
  baselineValue?: number | null | undefined;
  /** Pre-computed percent change, when the server already derived it. */
  changePercent?: number | null | undefined;
}): MetricComparison {
  const basisLabel = comparisonBasisLabel(input.mode);

  if (input.mode === "none" || basisLabel === null) {
    return { available: false, reason: "no_comparison_mode", basisLabel: null };
  }

  const direction = getMetricDirection(input.metricKey);

  const serverPercent =
    input.changePercent != null && Number.isFinite(input.changePercent)
      ? input.changePercent
      : null;

  const current =
    input.currentValue != null && Number.isFinite(input.currentValue) ? input.currentValue : null;
  const baseline =
    input.baselineValue != null && Number.isFinite(input.baselineValue) ? input.baselineValue : null;

  let changeValue: number | null = null;
  let changePercent: number | null = serverPercent;

  if (current !== null && baseline !== null) {
    changeValue = current - baseline;
    if (changePercent === null) {
      if (baseline === 0) {
        return { available: false, reason: "baseline_zero", basisLabel };
      }
      changePercent = (changeValue / Math.abs(baseline)) * 100;
    }
  }

  if (changePercent === null && changeValue === null) {
    if (current === null) {
      return { available: false, reason: "missing_current_value", basisLabel };
    }
    return { available: false, reason: "missing_baseline_value", basisLabel };
  }

  const signalForSentiment = changeValue ?? changePercent ?? 0;
  const arrow: "up" | "down" | "flat" =
    signalForSentiment > 0 ? "up" : signalForSentiment < 0 ? "down" : "flat";

  return {
    available: true,
    changePercent,
    changeValue,
    basisLabel,
    sentiment: deltaSentiment(direction, signalForSentiment),
    arrow,
  };
}
