/**
 * The Home metric contract.
 *
 * Adapts the existing overview read model into an explicit presentation
 * contract. It re-derives nothing: the numbers come from `OverviewSummaryData`
 * exactly as the server produced them. What it fixes is how a card is *allowed*
 * to describe them.
 *
 * Four rules the legacy path breaks:
 *
 * 1. **A missing comparison is not a zero comparison.** `overview-summary-support`
 *    calls `deltaSentiment(direction, changePct ?? 0)`, so a metric with no
 *    baseline gets the sentiment of a perfectly flat one. Comparison here goes
 *    through `resolveComparison`, which returns an unavailable comparison with a
 *    reason instead.
 * 2. **Direction is not desirability.** A rising CPA is an up arrow and a bad
 *    outcome; rising spend is neither good nor bad. The arrow and the colour are
 *    separate fields and the colour never derives from the arrow.
 * 3. **Money must say whether its currency was proven.** A configured currency is
 *    a preference, not an observation, and must never be silently rendered as if
 *    it had been read from the provider.
 * 4. **A value we do not have is unavailable, never 0.**
 */
import {
  resolveComparison,
  getMetricDirection,
  type ComparisonMode,
  type MetricComparison,
} from "@/lib/metric-semantics";
import type { CurrencyProof, EvidenceFreshness } from "@/lib/workspace/workspace-context";
import type {
  OverviewMetricCardData,
  OverviewMetricUnit,
  OverviewSummaryData,
} from "@/src/types/models";

export type HomeMetricAvailability = "available" | "partial" | "unavailable";

export interface HomeMoney {
  /** Account currency, or null when it is genuinely unknown. */
  currency: string | null;
  /** False when the currency is configured but never observed on the account. */
  proven: boolean;
  proof: CurrencyProof;
}

export interface HomeMetric {
  key: string;
  title: string;
  unit: OverviewMetricUnit;
  availability: HomeMetricAvailability;
  /** Null whenever the metric is not available. Never coerced to 0. */
  value: number | null;
  /** Why the value is missing or partial. Required when not available. */
  reason: string | null;
  comparison: MetricComparison;
  /** Present only for currency metrics. */
  money: HomeMoney | null;
  sparkline: ReadonlyArray<{ date: string; value: number | null }>;
  source: { key: string; label: string };
}

export interface HomeSourceState {
  key: string;
  label: string;
  state: "ok" | "partial" | "unavailable";
  /** Sentence a buyer can act on. Required when not ok. */
  reason: string | null;
  freshness: EvidenceFreshness;
  lastUpdatedAt: string | null;
  /**
   * What this row's own action is.
   *
   * "Unavailable" covers three different situations that need three different
   * ways out — a source that was never connected, one that is connected but has
   * nothing selected to read from, and one that is connected and simply stale.
   * A single "Connect this source" link served the first and misdescribed the
   * other two.
   */
  remedy?: "details" | "connect" | "select";
}

export interface HomeContract {
  metrics: HomeMetric[];
  sources: HomeSourceState[];
  window: { startDate: string; endDate: string };
  comparisonMode: ComparisonMode;
}

/** Metrics whose delta must never be coloured. Spend rising is not "bad". */
export const NEUTRAL_BY_POLICY = new Set(["spend"]);

function moneyFor(
  unit: OverviewMetricUnit,
  currency: string | null,
  proof: CurrencyProof,
): HomeMoney | null {
  if (unit !== "currency") return null;
  return {
    currency,
    // Only an observed currency is proven. `configured-only` is a preference
    // the buyer typed, and presenting it as fact is how a cross-currency total
    // becomes believable.
    proven: proof === "proven",
    proof,
  };
}

/**
 * Adapts one read-model card.
 *
 * `metricKey` is passed explicitly because the card's `id` is a UI slug
 * (`pins-blended-roas`) while the direction registry is keyed on the metric
 * name (`blended_roas`). Passing the slug silently yields `neutral` for every
 * cost metric, which is exactly the colour bug this contract exists to stop.
 */
export function toHomeMetric(input: {
  metricKey: string;
  card: OverviewMetricCardData | undefined;
  mode: ComparisonMode;
  currency: string | null;
  currencyProof: CurrencyProof;
  unavailableReason?: string;
}): HomeMetric {
  const { card, metricKey, mode } = input;

  if (!card || card.status === "unavailable" || card.value == null) {
    return {
      key: metricKey,
      title: card?.title ?? metricKey,
      unit: card?.unit ?? "count",
      availability: "unavailable",
      value: null,
      reason:
        input.unavailableReason ??
        card?.helperText ??
        "Not served for this business and window.",
      comparison: { available: false, reason: "missing_current_value", basisLabel: null },
      money: moneyFor(card?.unit ?? "count", input.currency, input.currencyProof),
      sparkline: [],
      source: card?.dataSource ?? { key: "unknown", label: "Unknown source" },
    };
  }

  const comparison = resolveComparison({
    metricKey,
    mode,
    currentValue: card.value,
    baselineValue: card.previousValue ?? null,
    changePercent: card.changePct ?? null,
  });

  return {
    key: metricKey,
    title: card.title,
    unit: card.unit,
    availability: card.status === "partial" ? "partial" : "available",
    value: card.value,
    reason: card.status === "partial" ? (card.helperText ?? "Some sources are incomplete.") : null,
    comparison,
    money: moneyFor(card.unit, input.currency, input.currencyProof),
    sparkline: card.sparklineData ?? [],
    source: card.dataSource,
  };
}

/** Colour token for a comparison. Never derived from the arrow. */
export function comparisonSentiment(
  metric: HomeMetric,
): "positive" | "negative" | "neutral" {
  if (!metric.comparison.available) return "neutral";
  if (NEUTRAL_BY_POLICY.has(metric.key)) return "neutral";
  if (getMetricDirection(metric.key) === "neutral") return "neutral";
  return metric.comparison.sentiment;
}

/** Human sentence for a comparison that cannot be shown. Never "0.0%". */
export function comparisonUnavailableCopy(comparison: MetricComparison): string {
  if (comparison.available) return "";
  switch (comparison.reason) {
    case "no_comparison_mode":
      return "No comparison selected";
    case "missing_current_value":
      return "No value for this window";
    case "missing_baseline_value":
      return "No comparable earlier window";
    case "baseline_zero":
      return "Earlier window was zero — percentage not meaningful";
  }
}

/** The metrics Home draws, in order, keyed to the direction registry. */
export const HOME_METRIC_KEYS = [
  { key: "revenue", cardId: "pins-revenue", section: "pins" },
  { key: "spend", cardId: "pins-spend", section: "pins" },
  { key: "blended_roas", cardId: "pins-blended-roas", section: "pins" },
  { key: "mer", cardId: "pins-mer", section: "pins" },
  { key: "orders", cardId: "pins-orders", section: "pins" },
  { key: "cpa", cardId: "custom-blended-cpa", section: "customMetrics" },
] as const;

function findCard(
  summary: OverviewSummaryData,
  section: string,
  cardId: string,
): OverviewMetricCardData | undefined {
  const bucket = (summary as unknown as Record<string, OverviewMetricCardData[] | undefined>)[
    section
  ];
  return Array.isArray(bucket) ? bucket.find((card) => card.id === cardId) : undefined;
}

export function buildHomeContract(input: {
  summary: OverviewSummaryData;
  currency: string | null;
  currencyProof: CurrencyProof;
  sources: HomeSourceState[];
}): HomeContract {
  const mode: ComparisonMode = input.summary.comparison.mode;

  return {
    metrics: HOME_METRIC_KEYS.map((entry) =>
      toHomeMetric({
        metricKey: entry.key,
        card: findCard(input.summary, entry.section, entry.cardId),
        mode,
        currency: input.currency,
        currencyProof: input.currencyProof,
      }),
    ),
    sources: input.sources,
    window: input.summary.dateRange,
    comparisonMode: mode,
  };
}

/**
 * Banner stack.
 *
 * Hard and partial banners coexist: a hard failure does not make a partial
 * source stop mattering, and collapsing to "the worst one" hides the fact that
 * two different things are wrong.
 */
export interface HomeBanner {
  severity: "hard" | "partial";
  key: string;
  message: string;
}

export function buildBannerStack(sources: readonly HomeSourceState[]): HomeBanner[] {
  const hard = sources
    .filter((source) => source.state === "unavailable")
    .map((source) => ({
      severity: "hard" as const,
      key: source.key,
      message: `${source.label} is unavailable. ${source.reason ?? ""}`.trim(),
    }));

  const partial = sources
    .filter((source) => source.state === "partial")
    .map((source) => ({
      severity: "partial" as const,
      key: source.key,
      message: `${source.label} is incomplete. ${source.reason ?? ""}`.trim(),
    }));

  // Hard first, but both kept: severity orders the stack, it does not filter it.
  return [...hard, ...partial];
}
