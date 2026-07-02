export const CREATIVE_DECISION_OS_V21_CONTRACT_VERSION =
  "creative-decision-os.v2.1";
export const CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION =
  "creative-decision-center.v2.1";

export const CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS = [
  "Scale",
  "Cut",
  "Refresh",
  "Protect",
  "Test More",
  "Diagnose",
] as const;

export const CREATIVE_DECISION_CENTER_BUYER_ACTIONS = [
  "scale",
  "cut",
  "refresh",
  "protect",
  "test_more",
  "watch_launch",
  "fix_delivery",
  "fix_policy",
  "diagnose_data",
] as const;

export const CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS = [
  "brief_variation",
  "creative_supply_warning",
  "winner_gap",
  "fatigue_cluster",
  "unused_approved_creatives",
] as const;

export const CREATIVE_DECISION_CENTER_ACTIONABILITIES = [
  "direct",
  "review_only",
  "blocked",
  "diagnose",
] as const;

export const CREATIVE_DECISION_CENTER_PROBLEM_CLASSES = [
  "performance",
  "creative",
  "fatigue",
  "delivery",
  "policy",
  "data_quality",
  "campaign_context",
  "insufficient_signal",
  "launch_monitoring",
] as const;

export const CREATIVE_DECISION_CENTER_MATURITY_LEVELS = [
  "too_early",
  "learning",
  "actionable",
  "mature",
] as const;

export const CREATIVE_DECISION_CENTER_PRIORITIES = [
  "critical",
  "high",
  "medium",
  "low",
] as const;

export const CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS = [
  "high",
  "medium",
  "low",
] as const;

export const CREATIVE_DECISION_CENTER_IDENTITY_GRAINS = [
  "ad",
  "creative",
  "asset",
  "family",
] as const;

export const CREATIVE_DECISION_CENTER_FRESHNESS_STATUSES = [
  "fresh",
  "stale",
  "unknown",
] as const;

export const CREATIVE_DECISION_CENTER_BENCHMARK_RELIABILITY_MINIMUMS = [
  "strong",
  "medium",
  "weak",
] as const;

// D016 separates the scale verdict from the campaign-kind execution CTA.
// D019 keeps `buyerAction` stable at 9 values and adds a nullable
// `executionAction` so Test/Main/Mixed scale rows can carry the correct
// operator-facing move without expanding the buyerAction union.
export const CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS = [
  "promote_to_main",
  "scale_budget",
  "controlled_scale",
] as const;

export type CreativeDecisionOsV21PrimaryDecision =
  (typeof CREATIVE_DECISION_OS_V21_PRIMARY_DECISIONS)[number];

export type CreativeDecisionCenterBuyerAction =
  (typeof CREATIVE_DECISION_CENTER_BUYER_ACTIONS)[number];

export type CreativeDecisionCenterAggregateAction =
  (typeof CREATIVE_DECISION_CENTER_AGGREGATE_ACTIONS)[number];

export type CreativeDecisionCenterActionability =
  (typeof CREATIVE_DECISION_CENTER_ACTIONABILITIES)[number];

export type CreativeDecisionCenterProblemClass =
  (typeof CREATIVE_DECISION_CENTER_PROBLEM_CLASSES)[number];

export type CreativeDecisionCenterMaturity =
  (typeof CREATIVE_DECISION_CENTER_MATURITY_LEVELS)[number];

export type CreativeDecisionCenterPriority =
  (typeof CREATIVE_DECISION_CENTER_PRIORITIES)[number];

export type CreativeDecisionCenterConfidenceBand =
  (typeof CREATIVE_DECISION_CENTER_CONFIDENCE_BANDS)[number];

export type CreativeDecisionCenterIdentityGrain =
  (typeof CREATIVE_DECISION_CENTER_IDENTITY_GRAINS)[number];

export type CreativeDecisionCenterFreshnessStatus =
  (typeof CREATIVE_DECISION_CENTER_FRESHNESS_STATUSES)[number];

export type CreativeDecisionCenterBenchmarkReliabilityMinimum =
  (typeof CREATIVE_DECISION_CENTER_BENCHMARK_RELIABILITY_MINIMUMS)[number];

export type CreativeDecisionCenterExecutionAction =
  (typeof CREATIVE_DECISION_CENTER_EXECUTION_ACTIONS)[number];

export interface CreativeDecisionOsV21Output {
  contractVersion: typeof CREATIVE_DECISION_OS_V21_CONTRACT_VERSION;
  engineVersion: string;
  primaryDecision: CreativeDecisionOsV21PrimaryDecision;
  actionability: CreativeDecisionCenterActionability;
  problemClass: CreativeDecisionCenterProblemClass;
  confidence: number;
  maturity: CreativeDecisionCenterMaturity;
  priority: CreativeDecisionCenterPriority;
  reasonTags: string[];
  evidenceSummary: string;
  blockerReasons: string[];
  missingData: string[];
  queueEligible: false;
  applyEligible: false;
}

export interface CreativeDecisionCenterRowDecision {
  scope: "creative";
  creativeId: string;
  rowId?: string;
  identityGrain: CreativeDecisionCenterIdentityGrain;
  familyId?: string | null;
  engine: CreativeDecisionOsV21Output;
  buyerAction: CreativeDecisionCenterBuyerAction;
  buyerLabel: string;
  uiBucket: CreativeDecisionCenterBuyerAction;
  /**
   * D019: optional campaign-kind execution CTA paired with `buyerAction`.
   * Null/absent for non-scale rows or scale rows without a labeled campaign kind.
   * Does not change `buyerAction` membership.
   */
  executionAction?: CreativeDecisionCenterExecutionAction | null;
  /**
   * D020: opaque audit metadata for the upstream engine label that produced this row
   * (for example V3 `keep`, `same_as_canonical`, `out_of_scope`).
   * Free-form string; must not expand `primaryDecision` union and must not be used
   * by UI to compute buyerAction. Adapter-only diagnostic surface.
   */
  sourceDecision?: string | null;
  confidenceBand: CreativeDecisionCenterConfidenceBand;
  priority: CreativeDecisionCenterPriority;
  oneLine: string;
  reasons: string[];
  nextStep: string;
  missingData: string[];
}

export interface CreativeDecisionCenterAggregateDecision {
  scope: "page" | "family";
  familyId?: string | null;
  action: CreativeDecisionCenterAggregateAction;
  priority: CreativeDecisionCenterPriority;
  confidence: number;
  oneLine: string;
  reasons: string[];
  affectedCreativeIds: string[];
  nextStep: string;
  missingData: string[];
}

export interface DecisionCenterSnapshot {
  contractVersion: typeof CREATIVE_DECISION_CENTER_V21_CONTRACT_VERSION;
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  generatedAt: string;
  dataFreshness: {
    status: CreativeDecisionCenterFreshnessStatus;
    maxAgeHours?: number | null;
    latestSnapshotAsOf?: string | null;
    snapshotAgeHours?: number | null;
  };
  inputCoverageSummary: Record<string, number>;
  missingDataSummary: Record<string, number>;
  todayBrief: Array<{
    id: string;
    priority: CreativeDecisionCenterPriority;
    text: string;
    rowIds: string[];
    aggregateIds?: string[];
  }>;
  actionBoard: Record<CreativeDecisionCenterBuyerAction, string[]>;
  rowDecisions: CreativeDecisionCenterRowDecision[];
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[];
}

export interface BuyerActionMappingRule {
  id: string;
  when: {
    primaryDecision?: CreativeDecisionOsV21PrimaryDecision;
    problemClass?: CreativeDecisionCenterProblemClass;
    reasonTagsAny?: string[];
    actionability?: CreativeDecisionCenterActionability;
    requiredData?: string[];
    blockersAbsent?: string[];
  };
  output: {
    buyerAction: CreativeDecisionCenterBuyerAction;
    buyerLabel: string;
    uiBucket: CreativeDecisionCenterBuyerAction;
    /**
     * D019: optional campaign-kind execution CTA emitted alongside `buyerAction`.
     * Null/absent rules do not assert an execution move.
     */
    executionAction?: CreativeDecisionCenterExecutionAction | null;
    nextStepTemplate: string;
  };
}

export interface CreativeDecisionConfig {
  configVersion: string;
  launchWindowHours: number;
  noSpendWindowHours: number;
  minSpendForMaturityMultiplier: number;
  minPurchasesForScale: number;
  minImpressionsForCtrReliability: number;
  fatigueCtrDropPct: number;
  fatigueCpmIncreasePct: number;
  fatigueFrequencyIncreasePct: number;
  maxCpaOverTargetForCut: number;
  minRoasOverTargetForScale: number;
  winnerGapDays: number;
  fatigueClusterTopN: number;
  benchmarkReliabilityMinimum: CreativeDecisionCenterBenchmarkReliabilityMinimum;
  staleDataHours: number;
  minConfidenceForScale: number;
  minConfidenceForCut: number;
}
