export const META_SIMULATION_SCORE_CONTRACT_VERSION =
  "meta-simulation-score.v1" as const;

export type MetaSimulationGrain = "campaign" | "adset" | "ad";

export type MetaSimulationEconomicVerdict =
  | "above_target"
  | "between_target_and_breakeven"
  | "below_breakeven"
  | "uncertain"
  | "not_applicable";

export type MetaSimulationPortfolioRole =
  | "current_winner"
  | "historical_winner"
  | "challenger"
  | "learning"
  | "declining"
  | "exhausted"
  | "unknown";

export type MetaSimulationAuthorityState =
  | "actionable"
  | "review_only"
  | "blocked_data"
  | "blocked_commercial"
  | "blocked_policy"
  | "blocked_delivery";

export type MetaSimulationOperationalState =
  | "active_delivery"
  | "paused_parent"
  | "no_delivery_verified"
  | "learning"
  | "policy_blocked"
  | "review_pending"
  | "unknown";

export type MetaSimulationCampaignExecutionAction =
  | "increase_campaign_budget"
  | "decrease_campaign_budget"
  | "pause_campaign"
  | "keep_campaign_budget"
  | "restructure_campaign"
  | "resolve_delivery"
  | "resolve_policy"
  | "none";

export type MetaSimulationAdsetExecutionAction =
  | "increase_adset_budget"
  | "decrease_adset_budget"
  | "pause_adset"
  | "keep_adset_budget"
  | "change_bid"
  | "restructure_adset"
  | "resolve_delivery"
  | "resolve_policy"
  | "none";

export type MetaSimulationAdExecutionAction =
  | "promote_to_main"
  | "keep_running"
  | "cut_ad"
  | "refresh_creative"
  | "continue_test"
  | "watch_launch"
  | "resolve_delivery"
  | "resolve_policy"
  | "none";

export type MetaSimulationExecutionAction =
  | MetaSimulationCampaignExecutionAction
  | MetaSimulationAdsetExecutionAction
  | MetaSimulationAdExecutionAction;

export type MetaSimulationExecutionActionForGrain<
  G extends MetaSimulationGrain,
> = G extends "campaign"
  ? MetaSimulationCampaignExecutionAction
  : G extends "adset"
    ? MetaSimulationAdsetExecutionAction
    : MetaSimulationAdExecutionAction;

export type MetaSimulationOutcomeStatus =
  "supported" | "refuted" | "neutral" | "unknown" | "censored";

export type MetaSimulationOutcomeProxyType =
  "state_truth" | "durability" | "treated_observational" | "causal";

export type MetaSimulationOutcomeSeverity =
  "critical" | "high" | "medium" | "low";

export type MetaSimulationPitStatus =
  "complete" | "partial" | "unreconstructable";

export type MetaSimulationTreatmentStatus =
  "acted_verified" | "acted_unverified" | "not_acted" | "unknown";

export type MetaSimulationEligibilityStatus =
  "eligible" | "ineligible" | "unknown";

export interface MetaSimulationCampaignEntity {
  accountId: string;
  campaignId: string;
}

export interface MetaSimulationAdsetEntity extends MetaSimulationCampaignEntity {
  adsetId: string;
}

export interface MetaSimulationAdEntity extends MetaSimulationAdsetEntity {
  adId: string;
  creativeId?: string | null;
}

export type MetaSimulationEntityForGrain<G extends MetaSimulationGrain> =
  G extends "campaign"
    ? MetaSimulationCampaignEntity
    : G extends "adset"
      ? MetaSimulationAdsetEntity
      : MetaSimulationAdEntity;

export interface MetaSimulationPitEvidence {
  status: MetaSimulationPitStatus;
  sourceGenerationIds: string[];
  targetHistoryId: string | null;
  configHistoryIds: string[];
  inputManifestHash: string;
  missing: string[];
}

export interface MetaSimulationDecision<G extends MetaSimulationGrain> {
  economicVerdict: MetaSimulationEconomicVerdict;
  portfolioRole: MetaSimulationPortfolioRole;
  authorityState: MetaSimulationAuthorityState;
  executionAction: MetaSimulationExecutionActionForGrain<G>;
  operationalState: MetaSimulationOperationalState;
  rawAction: MetaSimulationExecutionActionForGrain<G> | null;
  /** Probability-like confidence in [0, 1]. Values are clamped for scoring. */
  confidence: number;
}

export interface MetaSimulationOpportunity<G extends MetaSimulationGrain> {
  action: MetaSimulationExecutionActionForGrain<G>;
  /** The dated decision universe is formed at this instant, before outcomes. */
  evaluatedAt: string;
  eligibility: MetaSimulationEligibilityStatus;
  reasonCodes: string[];
}

export interface MetaSimulationTreatment {
  status: MetaSimulationTreatmentStatus;
  occurredAt: string | null;
  receiptId: string | null;
  contamination: string[];
}

export interface MetaSimulationOutcome {
  windowDays: 3 | 7 | 14;
  status: MetaSimulationOutcomeStatus;
  proxyType: MetaSimulationOutcomeProxyType;
  severity: MetaSimulationOutcomeSeverity | null;
  metrics: Record<string, number | null>;
  reasonCodes: string[];
}

export interface MetaSimulationContext {
  /** ISO 4217 code when known. Unknown currency is its own non-poolable stratum. */
  currency: string | null;
  objective: string | null;
  sourceMode: string;
}

export interface MetaSimulationEpisode<
  G extends MetaSimulationGrain = MetaSimulationGrain,
> {
  contractVersion: typeof META_SIMULATION_SCORE_CONTRACT_VERSION;
  grain: G;
  entity: MetaSimulationEntityForGrain<G>;
  asOfDate: string;
  cutoff: string;
  context: MetaSimulationContext;
  pit: MetaSimulationPitEvidence;
  decision: MetaSimulationDecision<G>;
  opportunity: MetaSimulationOpportunity<G>;
  treatment: MetaSimulationTreatment;
  outcome: MetaSimulationOutcome;
}

const HARD_EXECUTION_ACTIONS = new Set<MetaSimulationExecutionAction>([
  "increase_campaign_budget",
  "decrease_campaign_budget",
  "pause_campaign",
  "restructure_campaign",
  "increase_adset_budget",
  "decrease_adset_budget",
  "pause_adset",
  "change_bid",
  "restructure_adset",
  "promote_to_main",
  "cut_ad",
  "refresh_creative",
]);

export function isHardMetaSimulationAction(
  action: MetaSimulationExecutionAction,
): boolean {
  return HARD_EXECUTION_ACTIONS.has(action);
}

export interface MetaSimulationConfusionMatrix {
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
}

export interface MetaSimulationExplicitCosts {
  currency: string;
  falsePositive: number;
  falseNegative: number;
}

export interface MetaSimulationCostSummary {
  currency: string;
  total: number;
  averagePerEligibleEpisode: number | null;
}

export interface MetaSimulationConfidenceBucket {
  lowerInclusive: number;
  upperExclusive: number;
  known: number;
  supported: number;
  averageConfidence: number;
  observedSupportRate: number;
  absoluteGap: number;
}

export interface MetaSimulationActionScore {
  contractVersion: typeof META_SIMULATION_SCORE_CONTRACT_VERSION;
  grain: MetaSimulationGrain;
  action: MetaSimulationExecutionAction;
  currency: string | null;
  sampleSize: number;
  eligibleSampleSize: number;
  ineligibleSampleSize: number;
  unknownEligibilitySampleSize: number;
  emittedSampleSize: number;
  pairedConfusion: MetaSimulationConfusionMatrix;
  knownBinarySampleSize: number;
  neutralSampleSize: number;
  unknownSampleSize: number;
  censoredSampleSize: number;
  criticalFalsePositiveCount: number;
  precision: number | null;
  opportunityRecall: number | null;
  criticalFalsePositiveRate: number | null;
  missedOpportunityRate: number | null;
  unknownRate: number | null;
  censoredRate: number | null;
  expectedCalibrationError: number | null;
  confidenceBuckets: MetaSimulationConfidenceBucket[];
  cost: MetaSimulationCostSummary | null;
}

function round(value: number | null, digits = 4): number | null {
  return value === null ? null : Number(value.toFixed(digits));
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator) : null;
}

function normalizedCurrency(currency: string | null): string | null {
  const normalized = currency?.trim().toUpperCase() ?? "";
  return normalized || null;
}

function singleCurrency(episodes: readonly MetaSimulationEpisode[]) {
  const currencies = new Set(
    episodes.map((episode) => normalizedCurrency(episode.context.currency)),
  );
  if (currencies.size > 1) {
    throw new Error("meta simulation scoring cannot pool currencies");
  }
  return currencies.values().next().value ?? null;
}

function confidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function buildConfidenceBuckets(
  episodes: readonly MetaSimulationEpisode[],
): MetaSimulationConfidenceBucket[] {
  const buckets = new Map<
    number,
    { known: number; supported: number; confidenceSum: number }
  >();

  for (const episode of episodes) {
    if (
      episode.outcome.status !== "supported" &&
      episode.outcome.status !== "refuted"
    ) {
      continue;
    }
    const value = confidence(episode.decision.confidence);
    const index = Math.min(9, Math.floor(value * 10));
    const bucket = buckets.get(index) ?? {
      known: 0,
      supported: 0,
      confidenceSum: 0,
    };
    bucket.known += 1;
    bucket.confidenceSum += value;
    if (episode.outcome.status === "supported") bucket.supported += 1;
    buckets.set(index, bucket);
  }

  return Array.from(buckets.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, bucket]) => {
      const averageConfidence = bucket.confidenceSum / bucket.known;
      const observedSupportRate = bucket.supported / bucket.known;
      return {
        lowerInclusive: index / 10,
        upperExclusive: (index + 1) / 10,
        known: bucket.known,
        supported: bucket.supported,
        averageConfidence: round(averageConfidence) ?? 0,
        observedSupportRate: round(observedSupportRate) ?? 0,
        absoluteGap:
          round(Math.abs(averageConfidence - observedSupportRate)) ?? 0,
      };
    });
}

function expectedCalibrationError(
  buckets: readonly MetaSimulationConfidenceBucket[],
): number | null {
  const known = buckets.reduce((sum, bucket) => sum + bucket.known, 0);
  if (known === 0) return null;
  const weightedGap = buckets.reduce(
    (sum, bucket) => sum + bucket.absoluteGap * bucket.known,
    0,
  );
  return round(weightedGap / known);
}

function costSummary(input: {
  costs?: MetaSimulationExplicitCosts;
  currency: string | null;
  confusion: MetaSimulationConfusionMatrix;
  eligibleSampleSize: number;
}): MetaSimulationCostSummary | null {
  if (!input.costs) return null;
  const costCurrency = normalizedCurrency(input.costs.currency);
  if (input.currency === null || costCurrency !== input.currency) {
    throw new Error("explicit simulation costs must match the score currency");
  }
  if (
    !Number.isFinite(input.costs.falsePositive) ||
    !Number.isFinite(input.costs.falseNegative) ||
    input.costs.falsePositive < 0 ||
    input.costs.falseNegative < 0
  ) {
    throw new Error(
      "explicit simulation costs must be finite and non-negative",
    );
  }
  const total =
    input.confusion.falsePositive * input.costs.falsePositive +
    input.confusion.falseNegative * input.costs.falseNegative;
  return {
    currency: input.currency,
    total: round(total, 6) ?? 0,
    averagePerEligibleEpisode:
      input.eligibleSampleSize > 0
        ? round(total / input.eligibleSampleSize, 6)
        : null,
  };
}

/**
 * Scores one action-specific dated opportunity set. `supported` has the same
 * positive polarity whether the action was emitted (TP) or missed (FN).
 * Neutral, unknown, censored, and ineligible rows never enter binary metrics.
 */
export function scoreMetaSimulationAction<
  G extends MetaSimulationGrain,
>(input: {
  episodes: readonly MetaSimulationEpisode[];
  grain: G;
  action: MetaSimulationExecutionActionForGrain<G>;
  costs?: MetaSimulationExplicitCosts;
}): MetaSimulationActionScore {
  const episodes = input.episodes.filter(
    (episode) =>
      episode.grain === input.grain &&
      episode.opportunity.action === input.action,
  );
  const currency = singleCurrency(episodes);
  const eligible = episodes.filter(
    (episode) => episode.opportunity.eligibility === "eligible",
  );
  const emitted = eligible.filter(
    (episode) => episode.decision.executionAction === input.action,
  );
  const confusion: MetaSimulationConfusionMatrix = {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    trueNegative: 0,
  };
  let neutralSampleSize = 0;
  let unknownSampleSize = 0;
  let censoredSampleSize = 0;
  let criticalFalsePositiveCount = 0;

  for (const episode of eligible) {
    const wasEmitted = episode.decision.executionAction === input.action;
    if (episode.outcome.status === "supported") {
      if (wasEmitted) confusion.truePositive += 1;
      else confusion.falseNegative += 1;
    } else if (episode.outcome.status === "refuted") {
      if (wasEmitted) {
        confusion.falsePositive += 1;
        if (episode.outcome.severity === "critical") {
          criticalFalsePositiveCount += 1;
        }
      } else {
        confusion.trueNegative += 1;
      }
    } else if (episode.outcome.status === "neutral") {
      neutralSampleSize += 1;
    } else if (episode.outcome.status === "unknown") {
      unknownSampleSize += 1;
    } else if (episode.outcome.status === "censored") {
      censoredSampleSize += 1;
    }
  }

  const emittedKnown = confusion.truePositive + confusion.falsePositive;
  const positiveOpportunities =
    confusion.truePositive + confusion.falseNegative;
  const knownBinarySampleSize =
    confusion.truePositive +
    confusion.falsePositive +
    confusion.falseNegative +
    confusion.trueNegative;
  const calibrationEpisodes = isHardMetaSimulationAction(input.action)
    ? emitted.filter(
        (episode) =>
          episode.outcome.status === "supported" ||
          episode.outcome.status === "refuted",
      )
    : [];
  const confidenceBuckets = buildConfidenceBuckets(calibrationEpisodes);

  return {
    contractVersion: META_SIMULATION_SCORE_CONTRACT_VERSION,
    grain: input.grain,
    action: input.action,
    currency,
    sampleSize: episodes.length,
    eligibleSampleSize: eligible.length,
    ineligibleSampleSize: episodes.filter(
      (episode) => episode.opportunity.eligibility === "ineligible",
    ).length,
    unknownEligibilitySampleSize: episodes.filter(
      (episode) => episode.opportunity.eligibility === "unknown",
    ).length,
    emittedSampleSize: emitted.length,
    pairedConfusion: confusion,
    knownBinarySampleSize,
    neutralSampleSize,
    unknownSampleSize,
    censoredSampleSize,
    criticalFalsePositiveCount,
    precision: ratio(confusion.truePositive, emittedKnown),
    opportunityRecall: ratio(confusion.truePositive, positiveOpportunities),
    criticalFalsePositiveRate: ratio(criticalFalsePositiveCount, emittedKnown),
    missedOpportunityRate: ratio(
      confusion.falseNegative,
      positiveOpportunities,
    ),
    unknownRate: ratio(unknownSampleSize, eligible.length),
    censoredRate: ratio(censoredSampleSize, eligible.length),
    expectedCalibrationError: isHardMetaSimulationAction(input.action)
      ? expectedCalibrationError(confidenceBuckets)
      : null,
    confidenceBuckets,
    cost: costSummary({
      costs: input.costs,
      currency,
      confusion,
      eligibleSampleSize: eligible.length,
    }),
  };
}

export type MetaSimulationStratificationDimension =
  | "grain"
  | "action"
  | "account"
  | "objective"
  | "sourceMode"
  | "treatmentStatus"
  | "confidenceBand"
  | "windowDays";

export const DEFAULT_META_SIMULATION_STRATIFICATION_DIMENSIONS = [
  "grain",
  "action",
  "account",
  "objective",
  "sourceMode",
  "treatmentStatus",
  "confidenceBand",
  "windowDays",
] as const satisfies readonly MetaSimulationStratificationDimension[];

export function metaSimulationConfidenceBand(
  value: number,
): "low" | "medium" | "high" {
  const normalized = confidence(value);
  if (normalized >= 0.78) return "high";
  if (normalized >= 0.62) return "medium";
  return "low";
}

function keyPart(name: string, value: string | number | null) {
  return `${name}=${encodeURIComponent(value === null ? "unknown" : String(value))}`;
}

/** Currency is always included, even when callers request fewer dimensions. */
export function metaSimulationStratificationKey(
  episode: MetaSimulationEpisode,
  dimensions: readonly MetaSimulationStratificationDimension[] = DEFAULT_META_SIMULATION_STRATIFICATION_DIMENSIONS,
): string {
  const values: Record<
    MetaSimulationStratificationDimension,
    string | number | null
  > = {
    grain: episode.grain,
    action: episode.opportunity.action,
    account: episode.entity.accountId,
    objective: episode.context.objective,
    sourceMode: episode.context.sourceMode,
    treatmentStatus: episode.treatment.status,
    confidenceBand: metaSimulationConfidenceBand(episode.decision.confidence),
    windowDays: episode.outcome.windowDays,
  };
  const uniqueDimensions = Array.from(new Set(dimensions));
  return [
    keyPart("currency", normalizedCurrency(episode.context.currency)),
    ...uniqueDimensions.map((dimension) =>
      keyPart(dimension, values[dimension]),
    ),
  ].join("|");
}

export function groupMetaSimulationEpisodesByStratum(
  episodes: readonly MetaSimulationEpisode[],
  dimensions?: readonly MetaSimulationStratificationDimension[],
): Map<string, MetaSimulationEpisode[]> {
  const groups = new Map<string, MetaSimulationEpisode[]>();
  for (const episode of episodes) {
    const key = metaSimulationStratificationKey(episode, dimensions);
    const group = groups.get(key) ?? [];
    group.push(episode);
    groups.set(key, group);
  }
  return groups;
}
