/**
 * Creative Decision Engine v3 - public type contract.
 * Real decision logic is implemented gate by gate in subsequent tasks;
 * this file freezes the input/output shape so UI and data layer can be
 * built in parallel.
 */

import type { MetaFunnelCohort } from "@/lib/meta/funnel-cohort";
import type {
  MetaCampaignKind,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type { EngineV3Flags } from "./feature-flags";
import type { OperatorResponseResult } from "./operator-response-detection";
// `import type` is fully erased, so this pairing with ./commercial-anchor
// (which imports type-only from here) creates no runtime cycle.
import type {
  CommercialAnchorBlockerCode,
  CommercialAnchorExplanation,
} from "./commercial-anchor";

export const ENGINE_VERSION =
  "v3-2026-07-18-decision-presentation-hardening";
/** Parallel shadow epoch. It never keys legacy creative snapshot authority. */
export const NATIVE_AD_ENGINE_VERSION =
  "v3-ad-2026-07-18-decision-presentation-hardening-shadow";

/** Final decision label. */
export type DecisionLabel =
  | "scale"
  | "keep"
  | "refresh"
  | "cut"
  | "test_more"
  | "diagnose"
  | "out_of_scope";

/** Where the target_roas comparison value came from. */
export type TruthSource =
  | "commercial_truth"
  | "commercial_truth_stale"
  | "account_baseline"
  | "account_baseline_thin"
  | "global_default";

/** Campaign objective family. Only `OUTCOME_SALES` is in scope for Phase 1. */
export type CampaignObjective =
  | "OUTCOME_SALES"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_TRAFFIC"
  | "OUTCOME_LEADS"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_APP_PROMOTION";

/** Aggression preset that maps to scale_ratio_threshold. */
export type AggressionPreset = "aggressive" | "balanced" | "conservative";

export type EngineRiskPreset = "aggressive" | "balanced" | "conservative";

export type SpendUnitSource =
  | "target_cpa"
  | "operator_aov"
  /**
   * Average order value observed in the store's own orders, divided by the
   * configured Target ROAS. It sits above the Meta-attributed estimate because
   * it is the merchant's own settled revenue rather than an attribution view of
   * it, and below an explicitly configured target because a configured number
   * is a decision and this is a measurement.
   */
  | "observed_shopify_aov"
  | "meta_derived_aov"
  | "account_history"
  | "break_even_aov"
  | "insufficient";

export type SpendUnitConfidence = "high" | "medium" | "low" | "insufficient";

export type MetaAovQuality =
  "unavailable" | "unstable" | "low_sample" | "ready";

export type CommercialTargetFreshness = "fresh" | "stale" | "unknown";

export type ThresholdQuality = "ready" | "degraded" | "insufficient";

export type DecisionProfileScopeType = "account" | "campaign";

export type DecisionProfileScopeFallbackReason =
  "campaign_calibration_missing" | "campaign_sample_below_threshold";

export interface DecisionProfileScope {
  type: DecisionProfileScopeType;
  id: string;
  fallbackReason?: DecisionProfileScopeFallbackReason;
}

export interface SpendUnitEvidence {
  targetCpa: number | null;
  operatorAovAssumption: number | null;
  /**
   * Observed store AOV in MAJOR units, with the order count that produced it.
   * Absent (undefined) on payloads written before the source existed; null
   * means it was looked for and not usable.
   */
  observedShopifyAov?: number | null;
  observedShopifyAovOrderCount?: number;
  observedShopifyAovStatus?: string | null;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  warnings: string[];
  /** Confidence produced by spend-unit evidence before commercial-target
   * provenance validation. Used to avoid charging an unavailable timestamp
   * more than once. Target age itself never caps confidence. */
  confidenceBeforeFreshness?: SpendUnitConfidence;
}

export interface SpendUnitProfile {
  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  spendUnitEvidence: SpendUnitEvidence;
  hardEligibleByDefault: boolean;
  /**
   * True when a target pack supplied the commercial threshold but its update
   * timestamp could not be trusted, so the confidence was demoted to `low`.
   * Distinguishes "re-save the existing target" from "no anchor was ever
   * supplied"; optional so pre-contract profiles deserialize unchanged.
   */
  commercialThresholdProvenanceUnverified?: boolean;
}

export interface EngineMultiplierSet {
  zeroConvBurner: number;
  cutCandidate: number;
  sustainedLoser: number;
  lossBudget: number;
  hardCut: number;
  scalePurchase: number;
  winnerMemory: number;
  recentSample: number;
  weakFunnelRate: number;
}

export interface EngineThresholdSet {
  zeroConvBurnerSpend: number | null;
  cutCandidateSpend: number | null;
  sustainedLoserSpend: number | null;
  commercialMaturitySpend: number | null;
  hardCutSpend: number | null;
  recentSampleMinSpend: number | null;
  winnerMemoryMinSpend: number | null;
  scaleMinPurchases: number;
  winnerMemoryMinPurchases: number;
  bottomQuartileRatio: number | null;
  severeLoserRatio: number | null;
}

export interface HardActionEligibility {
  scale: boolean;
  cut: boolean;
  refresh: boolean;
  reason: string | null;
  reasons?: Partial<Record<"scale" | "cut" | "refresh", string | null>>;
  /**
   * Stable machine codes for exactly the same withholding the prose `reasons`
   * describe. Additive and optional: profiles serialized before this contract
   * omit it. Absence means "code unknown" and must never be read as eligible —
   * the booleans remain the only authority.
   */
  codes?: Partial<
    Record<"scale" | "cut" | "refresh", CommercialAnchorBlockerCode | null>
  >;
  /**
   * Full commercial-anchor explanation: resolved spend unit, its source,
   * confidence, input lineage, and the exact inputs that would unblock it.
   * Additive and optional for the same compatibility reason.
   */
  anchor?: CommercialAnchorExplanation | null;
}

export type LifecyclePosition =
  | "rising"
  | "plateau"
  | "closing"
  | "past_peak_inaction"
  | "past_peak_natural"
  | "past_peak_unclear"
  | "volatile"
  | "insufficient_history";

export type SpendTrajectory =
  "rising" | "flat" | "falling" | "volatile" | "unknown";

export type CreativeFormat =
  "image" | "video" | "carousel" | "catalog" | "other";

export type MetaRanking =
  "above_average" | "average" | "below_average" | "unknown";

export type FunnelStage =
  | "upper_funnel"
  | "landing_page"
  | "checkout"
  | "tracking"
  | "none"
  | "insufficient_signal";

export interface FunnelRates {
  ctr: number | null;
  outboundClickRate: number | null;
  linkToLpvRate: number | null;
  linkToAtcRate: number | null;
  lpvToAtcRate: number | null;
  atcToIcRate: number | null;
  icToPurchaseRate: number | null;
  atcToPurchaseRate: number | null;
  clickToPurchaseRate: number | null;
}

export interface FunnelDiagnosis {
  primaryWeakStage: FunnelStage;
  creativeResponsible: boolean;
  confidence: number;
  evidence: string[];
  rates: FunnelRates;
}

export interface FormatFunnelBaseline {
  creativeFormat: string;
  ctrP25: number | null;
  ctrP50: number | null;
  cpmP50: number | null;
  cpmP75: number | null;
  thumbstopP25: number | null;
  thumbstopP50: number | null;
  linkToLpvP25: number | null;
  linkToLpvP50: number | null;
  linkToAtcP25: number | null;
  linkToAtcP50: number | null;
  lpvToAtcP25: number | null;
  lpvToAtcP50: number | null;
  atcToIcP25: number | null;
  atcToIcP50: number | null;
  icToPurchaseP25: number | null;
  icToPurchaseP50: number | null;
  clickToPurchaseP25: number | null;
  clickToPurchaseP50: number | null;
  sampleSize: number;
  qualityStatus: "ready" | "low_sample" | "insufficient";
}

export interface AccountFunnelCalibration {
  campaignKind?: CalibrationCampaignKind;
  byFormat: Record<string, FormatFunnelBaseline>;
}

export type CalibrationCampaignKind = "all" | MetaCampaignKind;

/**
 * Server-owned cardinality of the exact 28-day source grain used to hydrate a
 * creative. The purchase engine has authority only when every required
 * context dimension is known and singular.
 */
export interface CreativeDecisionContextGrain {
  providerAccountCount: number;
  campaignCount: number;
  adsetCount: number;
  optimizationContextCount: number;
  objectiveCount: number;
  contextIdentityUnknown: boolean;
}

/** Per-creative metric inputs the engine needs to decide. */
export interface CreativeInput {
  creativeId: string;
  creativeName: string | null;
  businessId: string;
  campaignId: string | null;
  /**
   * Native execution identity. Optional here so legacy resolver fixtures and
   * creative-grain read surfaces remain source-compatible. Production ad
   * hydration exposes these as required fields through `AdDecisionInput`.
   */
  decisionEntityType?: "ad";
  decisionEntityId?: string;
  adId?: string;
  providerAccountId?: string;
  /** Provider account currency for deterministic decision copy. Decision
   * math never infers a currency when this evidence is unavailable. */
  accountCurrency?: string | null;
  adsetId?: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  /**
   * Server-resolved Main/Test/Mixed campaign role. Routes/jobs populate this
   * from account-scoped automatic inference before calling decideCreative; UI
   * must not derive or override it.
   */
  campaignKind?: MetaCampaignKind | null;

  // Scope
  objective: CampaignObjective | null;
  /**
   * Populated by production hydration paths. Optional only for legacy unit
   * fixtures and explicit callers that predate the grain contract.
   */
  contextGrain?: CreativeDecisionContextGrain;
  /**
   * Resolved cohort across every positive-spend optimization context in the
   * rollup window. Mixed cohorts resolve to `unknown`; null means no spend.
   */
  effectiveCohort?: MetaFunnelCohort | null;

  // Cumulative metrics (28d window, conventional)
  spend: number;
  purchases: number;
  purchaseValue: number | null;
  impressions: number | null;
  linkClicks: number | null;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
  frequency: number | null;

  // Recent window (7d)
  recent7dSpend: number | null;
  recent7dPurchases: number | null;
  recent7dRoas: number | null;
  recent7dImpressions: number | null;

  // Lifecycle / status
  effectiveStatus: "ACTIVE" | "PAUSED" | "DELETED" | "REJECTED" | null;
  ageDays: number | null;
  firstSeenAt?: string | null;
  firstSpendAt?: string | null;
  lastSpendAt: string | null;
  spend24h?: number | null;
  impressions24h?: number | null;
  reviewStatus?: string | null;
  policyReason: string | null;
  disapprovalReason?: string | null;
  limitedReason?: string | null;
  dataFreshnessHours: number | null;

  // Fatigue (reused from V1 fatigue motor - value passed in, engine doesn't recompute)
  fatigueStatus: "none" | "watch" | "fatigued" | "unknown" | null;

  // Commercial truth (resolved upstream - engine consumes pre-resolved target)
  // If null the engine falls back through the truth resolution chain.
  targetRoas: number | null;
  breakevenRoas: number | null;
  commercialTargetFreshness?: CommercialTargetFreshness;

  // Lifecycle signals (Phase 3.4+); populated from engine_v3_creative_lifecycle_daily.
  lifecyclePosition?: LifecyclePosition | null;
  daysSincePeak?: number | null;
  peakRoas30d?: number | null;
  peakConfidence?: number | null;
  spendTrajectory30d?: SpendTrajectory | null;
  spendSlope7d?: number | null;
  spendSlope30d?: number | null;
  roasSlope7d?: number | null;
  roasSlope30d?: number | null;

  // Funnel signals (Phase 3.9); null when warehouse data is missing.
  cpm: number | null;
  outboundClicks: number | null;
  landingPageViews: number | null;
  addToCart: number | null;
  initiateCheckout: number | null;
  thumbstop: number | null;
  video25Rate: number | null;
  video50Rate: number | null;
  video75Rate: number | null;
  video100Rate: number | null;
  qualityRanking: MetaRanking | null;
  engagementRateRanking: MetaRanking | null;
  conversionRateRanking: MetaRanking | null;
  creativeFormat: CreativeFormat | null;
}

export type AdDecisionStatusSource =
  | "entity_state_history"
  | "entity_tombstone"
  | "current_dimension"
  | "missing";

export interface AdDecisionStatusEvidence {
  source: AdDecisionStatusSource;
  sourceRecordId: string | null;
  observedAt: string | null;
  capturedAt: string | null;
}

/**
 * Creative-owned context may explain an ad, but never identifies or aggregates
 * the ad. In particular, no creative-wide spend/ROAS field belongs here.
 */
export interface AdCreativeEvidenceOverlay {
  sourceLifecycleRowId: string | null;
  sourceAsOfDate: string | null;
  sourceComputedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  lifecyclePosition: LifecyclePosition | null;
  daysSincePeak: number | null;
  peakRoas30d: number | null;
  peakConfidence: number | null;
  spendTrajectory30d: SpendTrajectory | null;
  spendSlope7d: number | null;
  spendSlope30d: number | null;
  roasSlope7d: number | null;
  roasSlope30d: number | null;
  fatigueStatus: CreativeInput["fatigueStatus"];
  qualityRanking: MetaRanking | null;
  engagementRateRanking: MetaRanking | null;
  conversionRateRanking: MetaRanking | null;
  creativeFormat: CreativeFormat | null;
}

export interface AdDecisionMetricEvidence {
  /** Number of finalized, validated native ad-day rows in the 28d window. */
  sourceRowCount: number;
  /** False for a present-day dimension/state ad that has no insights row yet. */
  performanceMetricsObserved: boolean;
  /**
   * Meta action/event fields are optional in payload_json. False means null is
   * unknown, not a measured zero.
   */
  eventMetricsObserved: boolean;
}

/**
 * Native Meta Ads decision input. Identity is business/account/ad; creativeId
 * is nullable portfolio grouping only and must never own provider execution.
 */
export interface AdDecisionInput extends Omit<
  CreativeInput,
  | "creativeId"
  | "decisionEntityType"
  | "decisionEntityId"
  | "adId"
  | "providerAccountId"
  | "adsetId"
  | "optimizationGoal"
  | "customEventType"
> {
  decisionEntityType: "ad";
  decisionEntityId: string;
  adId: string;
  providerAccountId: string;
  /** Physical provider-account identity used by native persistence FKs. */
  providerAccountRefId: string;
  /** Cutoff-safe native account identity used to select calibration authority. */
  accountTimezone: string | null;
  accountCurrency: string | null;
  adsetId: string | null;
  creativeId: string | null;
  optimizationGoal: string | null;
  customEventType: string | null;
  metricEvidence: AdDecisionMetricEvidence;
  statusEvidence: AdDecisionStatusEvidence;
  creativeEvidence: AdCreativeEvidenceOverlay;
}

/** Per-business runtime configuration (Tier 2). */
export interface BusinessConfig {
  businessId: string;

  // Aggression preset -> scale ratio threshold
  aggression: AggressionPreset;
  scaleRatioThreshold: number;

  // Recent window sample size
  recentSampleMinSpend: number;

  // Self-calibration baseline quantile
  accountBaselineQuantile: number;

  // Truth penalty (confidence delta when commercial_truth missing)
  truthPenaltyForDegraded: number;

  // Global default target_roas when no truth and no account history
  globalDefaultTargetRoas: number;

  // CTR low threshold cold-start fallback
  lowCtrThresholdFallback: number;
}

/** Self-calibrated per-account values (Tier 3). Computed from the warehouse, not user-set. */
export interface AccountCalibration {
  businessId: string;
  computedAt: string;
  campaignKind?: CalibrationCampaignKind;

  // Mature creative pool size (drives which baseline tier applies)
  matureCreativeCount: number;

  // ROAS distribution percentiles (null when sample too small)
  roasP75: number | null;
  roasP60: number | null;

  // Recent/total ROAS ratio P10 (drives refresh trend gate)
  refreshRatioP10: number | null;

  // CTR P10 (drives "low CTR" badge threshold)
  lowCtrP10: number | null;

  // Phase 3.8 account-relative threshold evidence
  accountCpaP50: number | null;
  accountCpaSampleCount: number;
  metaAttributedAovMean90d: number | null;
  metaAttributedAovPurchaseCount90d: number;
  metaAttributedRevenue90d: number;
  matureSpendP50: number | null;
  matureSpendP75: number | null;
  winnerSpendP25: number | null;
  winnerSpendP50: number | null;
  winnerPurchaseP50: number | null;
  roasRatioP10: number | null;
  roasRatioP25: number | null;
  roasRatioP50: number | null;
  roasRatioP75: number | null;
  metaAovQuality: MetaAovQuality;
}

export interface AccountDecisionProfile {
  businessId: string;
  asOfDate: string;
  channel: "meta";
  objectiveFamily: "sales";

  preset: EngineRiskPreset;
  presetSource:
    | "business_engine_v3_flags_override"
    | "business_decision_calibration_profile"
    | "target_pack_risk_posture"
    | "default";

  spendUnit: number | null;
  spendUnitSource: SpendUnitSource;
  spendUnitConfidence: SpendUnitConfidence;
  spendUnitEvidence: SpendUnitEvidence;

  multipliers: EngineMultiplierSet;
  thresholds: EngineThresholdSet;
  /**
   * Cut-only commercial stop-loss thresholds derived by the canonical profile
   * resolver from a separately authenticated account/currency AOV proof.
   * Scale, Refresh, fatigue, and lifecycle consumers must keep using
   * `thresholds`.
   */
  commercialStopLossSpendUnit?: SpendUnitProfile | null;
  commercialStopLossThresholds?: EngineThresholdSet | null;
  /**
   * Immutable pre-overlay authority used to keep the account-AOV repair
   * Cut-only. The engine restores this view for every row that would not end
   * in a Cut under the repaired, monotonic stop-loss policy.
   */
  commercialStopLossCanonicalHardActionEligibility?: HardActionEligibility | null;
  /**
   * Native readiness provenance for D063's expanded P25-to-break-even strip.
   * Undefined preserves the canonical non-native policy. Native profiles set
   * this explicitly so a legacy-only `calibrated_relative` receipt cannot
   * silently authorize the expanded economic region.
   */
  expandedEconomicCutAuthority?: {
    eligible: boolean;
    authorityBasis:
      | "calibrated_relative_with_economic_stop_loss"
      | "commercial_stop_loss"
      | null;
    reason: string | null;
  };
  accountBaselines: AccountCalibration;
  funnelCalibration: AccountFunnelCalibration;
  /**
   * @phase-1b-data-only
   * Kind-segmented account baselines are exposed for observability and P1c.
   * Resolver gates must continue reading accountBaselines/funnelCalibration
   * until the kind-aware decision phase is explicitly implemented.
   */
  accountBaselinesByKind?: Record<
    CalibrationCampaignKind,
    AccountCalibration | null
  >;
  /**
   * @phase-1c-kind-aware
   * Precomputed spend-unit resolutions and thresholds keyed by campaign kind.
   * Gate files select a prepared profile view instead of recomputing math.
   */
  spendUnitByKind?: Record<CalibrationCampaignKind, SpendUnitProfile | null>;
  thresholdsByKind?: Record<CalibrationCampaignKind, EngineThresholdSet | null>;
  hardActionEligibilityByKind?: Record<
    CalibrationCampaignKind,
    HardActionEligibility | null
  >;
  /**
   * @phase-1b-data-only
   * Kind-segmented funnel baselines are data-only in P1b.
   */
  funnelCalibrationByKind?: Record<
    CalibrationCampaignKind,
    AccountFunnelCalibration | null
  >;
  scope: DecisionProfileScope;

  hardActionEligibility: HardActionEligibility;

  quality: {
    commercialTruthReady: boolean;
    commercialTruthFreshness?: CommercialTargetFreshness;
    calibrationReady: boolean;
    metaAovQuality: MetaAovQuality;
    thresholdQuality: ThresholdQuality;
  };
}

/** Output badge - UI hint, does not change label. */
export interface DecisionBadge {
  type:
    | "fatigue_watch"
    | "fatigue_fatigued"
    | "cut_candidate"
    | "low_ctr"
    | "truth_account_baseline"
    | "truth_account_baseline_thin"
    | "truth_commercial_stale"
    | "truth_global_default"
    | "missing_recent_data"
    | "weak_performance"
    | "below_breakeven"
    | "stale_calibration"
    | "stale_lifecycle"
    | "stale_decision_context"
    | "stale_evidence"
    | "unknown_freshness"
    | "lifecycle_unavailable"
    | "opportunity_window_open"
    | "opportunity_window_closing"
    | "past_peak_unclear_signal"
    | "volatile_trend"
    | "tracking_anomaly"
    | "quality_only_assessment"
    | "creative_quality_weak"
    | "delivery_limited"
    | "delivery_no_spend_24h"
    | "delivery_status_unknown"
    | "policy_blocked"
    | "launch_monitoring"
    | "landing_page_issue"
    | "checkout_breakdown"
    | "upper_funnel_strong_site_weak"
    | "scale_readiness_blocked"
    | "scale_calibration_thin"
    | "unlabeled_campaign_context"
    | "campaign_context_unresolved"
    | "campaign_context_low_confidence"
    | "campaign_context_conflict"
    | "native_calibration_unavailable"
    | "ad_metrics_unavailable"
    | "pending_transition"
    | "stale_hard_ceiling_advisory"
    | "resume_candidate"
    | "confirm_kill"
    | "stop_loss_review";
  label: string;
  severity: "info" | "warning";
}

export const DECISION_BADGE_DISPLAY: Record<
  DecisionBadge["type"],
  { label: string; severity: DecisionBadge["severity"] }
> = {
  fatigue_watch: { label: "Fatigue watch", severity: "warning" },
  fatigue_fatigued: { label: "Fatigued", severity: "warning" },
  cut_candidate: { label: "Cut candidate", severity: "warning" },
  low_ctr: { label: "Low CTR", severity: "info" },
  truth_account_baseline: {
    label: "Truth: account baseline",
    severity: "info",
  },
  truth_account_baseline_thin: {
    label: "Truth: thin account baseline",
    severity: "warning",
  },
  truth_commercial_stale: {
    label: "Target timestamp unavailable - reduced authority",
    severity: "warning",
  },
  truth_global_default: {
    label: "Truth: global default",
    severity: "warning",
  },
  missing_recent_data: { label: "Recent data missing", severity: "warning" },
  weak_performance: { label: "Below target", severity: "warning" },
  below_breakeven: { label: "Below breakeven", severity: "warning" },
  stale_calibration: { label: "Calibration stale", severity: "warning" },
  stale_lifecycle: { label: "Lifecycle stale", severity: "warning" },
  stale_decision_context: {
    label: "Stale decision context",
    severity: "info",
  },
  stale_evidence: {
    label: "Stale evidence",
    severity: "warning",
  },
  unknown_freshness: {
    label: "Unknown freshness",
    severity: "warning",
  },
  campaign_context_unresolved: {
    label: "Campaign context unresolved",
    severity: "warning",
  },
  campaign_context_low_confidence: {
    label: "Campaign context low confidence",
    severity: "warning",
  },
  campaign_context_conflict: {
    label: "Campaign context conflict",
    severity: "warning",
  },
  native_calibration_unavailable: {
    label: "Native calibration unavailable - hard actions blocked",
    severity: "warning",
  },
  ad_metrics_unavailable: {
    label: "Ad performance data unavailable",
    severity: "warning",
  },
  pending_transition: {
    label: "Label transition pending",
    severity: "info",
  },
  stale_hard_ceiling_advisory: {
    label: "Hard action on very stale data",
    severity: "warning",
  },
  resume_candidate: {
    label: "Paused delivery - scale means resume candidate",
    severity: "info",
  },
  confirm_kill: {
    label: "Paused delivery - cut means confirm kill",
    severity: "info",
  },
  lifecycle_unavailable: {
    label: "Lifecycle data unavailable",
    severity: "info",
  },
  opportunity_window_open: {
    label: "Opportunity window — act now",
    severity: "info",
  },
  opportunity_window_closing: {
    label: "Opportunity window closing",
    severity: "warning",
  },
  past_peak_unclear_signal: {
    label: "Past peak — operator review",
    severity: "warning",
  },
  volatile_trend: {
    label: "Volatile trend — signal noisy",
    severity: "warning",
  },
  tracking_anomaly: {
    label: "Tracking anomaly",
    severity: "warning",
  },
  quality_only_assessment: {
    label: "Quality-only assessment",
    severity: "info",
  },
  creative_quality_weak: {
    label: "Creative quality weak",
    severity: "warning",
  },
  delivery_limited: {
    label: "Limited delivery signal",
    severity: "info",
  },
  delivery_no_spend_24h: {
    label: "No delivery in verified 24h window",
    severity: "warning",
  },
  delivery_status_unknown: {
    label: "Delivery status unavailable",
    severity: "warning",
  },
  policy_blocked: {
    label: "Policy or review block",
    severity: "warning",
  },
  launch_monitoring: {
    label: "Launch monitoring",
    severity: "info",
  },
  landing_page_issue: {
    label: "Landing page issue",
    severity: "warning",
  },
  checkout_breakdown: {
    label: "Checkout breakdown",
    severity: "warning",
  },
  upper_funnel_strong_site_weak: {
    label: "Upper funnel strong, site weak",
    severity: "info",
  },
  scale_readiness_blocked: {
    label: "Scale readiness blocked",
    severity: "info",
  },
  scale_calibration_thin: {
    label: "Scale calibration thin",
    severity: "warning",
  },
  unlabeled_campaign_context: {
    label: "Campaign role unresolved",
    severity: "warning",
  },
  stop_loss_review: {
    label: "Stop-loss review",
    severity: "warning",
  },
};

/**
 * @deprecated Legacy wire alias (D074b). Parse-only: older persisted
 * snapshots/evaluations carry it; active writers emit
 * `CreativeCampaignRoleStatus` instead. Normalize through
 * `resolveCampaignRoleStatus` in campaign-label-guard.ts.
 */
export type CreativeCampaignLabelStatus =
  "labeled" | "unlabeled" | "no_campaign";

/** Canonical automatic campaign-role resolution status (D074b). */
export type CreativeCampaignRoleStatus =
  "resolved" | "unresolved" | "no_campaign";

export type DecisionKindSource =
  "kind_main" | "kind_test" | "kind_mixed" | "all_fallback";

export type DecisionLabelTransform = "test_cohort_refresh_to_cut";

export const DECISION_AUTHORITY_BLOCKERS = [
  "profile_hard_action_ineligible",
  "source_freshness",
  "campaign_context",
  "native_metrics_unavailable",
  "native_profile_unavailable",
  "recent_recovery_unverifiable",
] as const;

export type DecisionAuthorityBlocker =
  (typeof DECISION_AUTHORITY_BLOCKERS)[number];

export interface DecisionPredicateBlocker {
  predicate: string;
  observed: string | number | null;
  threshold: string | number | null;
  status: "failed" | "missing";
  severity: "info" | "warning";
  reason: string;
}

/** Final per-creative decision. */
export interface DecisionOutput {
  creativeId: string;
  creativeName: string | null;
  label: DecisionLabel;
  reason: string;
  confidence: number;
  truthSource: TruthSource;
  effectiveTargetRoas: number;
  ratioToTarget: number | null;
  badges: DecisionBadge[];
  blockers?: DecisionPredicateBlocker[];
  metrics: {
    spend: number;
    purchases: number;
    roas: number | null;
    recent7dRoas: number | null;
  };
  /** Canonical automatic role-resolution status (D074b); active writers
   * emit this. */
  campaignRoleStatus?: CreativeCampaignRoleStatus;
  /** @deprecated parse-only legacy alias — never emitted by active writers. */
  campaignLabelStatus?: CreativeCampaignLabelStatus;
  campaignKind?: MetaCampaignKind | null;
  campaignTestDimension?: MetaCampaignTestDimension | null;
  /**
   * Decision after semantic transforms and before the first authority
   * restriction. This field is evidence only and never authorizes execution.
   */
  preAuthorityLabel: DecisionLabel;
  /** First effective authority restriction; later restrictions must preserve it. */
  authorityBlocker: DecisionAuthorityBlocker | null;
  blockedActionType?: DecisionLabel | null;
  /**
   * Read-only diagnostic: tells audit/API consumers whether the decision used
   * kind-specific baselines or the canonical account-wide fallback. UI must not
   * derive decision behavior from this field.
   */
  decisionKindSource?: DecisionKindSource;
  /**
   * Read-only diagnostic: records semantic label transforms applied by the
   * engine pipeline. UI must not derive decision behavior from this field.
   */
  labelTransform?: DecisionLabelTransform | null;
  engineVersion: string;
  generatedAt: string;
}

/**
 * Native Meta ad decision. creativeId remains nullable grouping metadata; the
 * required business/account/ad fields are the only execution identity.
 */
export interface AdDecisionOutput extends Omit<DecisionOutput, "creativeId"> {
  decisionEntityType: "ad";
  decisionEntityId: string;
  adId: string;
  providerAccountId: string;
  creativeId: string | null;
}

/**
 * Data freshness tier for a single data layer (calibration, lifecycle, decisions).
 *
 * - `none`     -> data is recent (<36h since source max date), no UI signal needed
 * - `warning`  -> data is stale (36-72h), confidence reduced + UI badge shown
 * - `unknown`  -> source freshness is unavailable; render warning-equivalent,
 *                 but do not infer a formula threshold or fresh state
 * - `disabled` -> data is too stale (>72h), data-derived intelligence is disabled
 *                 (engine falls back to core gates only)
 */
export type StaleTier = "none" | "warning" | "unknown" | "disabled";

/**
 * Fallback mode applied at the data layer.
 *
 * - `precomputed` -> data came from the pre-computed table (preferred)
 * - `runtime_sql` -> fallback: data computed at request time via SQL (acceptable for calibration only)
 * - `insufficient` -> no data available; the consuming gate disables itself
 */
export type FallbackMode = "precomputed" | "runtime_sql" | "insufficient";

/** Health snapshot of a single data layer. */
export interface DataLayerHealth {
  /** ISO date the underlying source data is current through. */
  asOfDate: string | null;
  /** ISO timestamp the layer was last computed. */
  computedAt: string | null;
  /** Hours between source max updated_at and now. Null if unknown. */
  sourceFreshnessHours: number | null;
  /** Tier classification. */
  staleTier: StaleTier;
  /** Where this layer's data came from. */
  fallbackMode: FallbackMode;
  /** Optional human-readable note for operator diagnostics. */
  note: string | null;
}

/** Aggregated data health across all layers used in a decision response. */
export interface DataHealth {
  calibration: DataLayerHealth;
  lifecycle: DataLayerHealth;
  decisions: DataLayerHealth;
  /** Worst tier across all layers. UI uses this for the top-level badge. */
  worstTier: StaleTier;
  /** True if any layer is in `disabled` tier - engine ran in degraded mode. */
  degraded: boolean;
}

/** Full API response from the engine endpoint. */
export interface DecisionResponse {
  status?: "ok";
  businessId: string;
  asOf: string;
  engineVersion: string;
  dataSource: "warehouse" | "mock";
  dataHealth: DataHealth;
  scope: DecisionProfileScope;
  accountProfile: AccountDecisionProfile;
  decisions: DecisionOutput[];
  flags: EngineV3Flags;
}

export interface DecisionDisabledResponse {
  status: "disabled";
  reason: "engine_v3_disabled_for_business";
  flags: EngineV3Flags;
  decisions?: undefined;
  accountProfile?: undefined;
  dataHealth?: undefined;
  dataSource?: undefined;
  engineVersion?: undefined;
  businessId?: undefined;
  asOf?: undefined;
}

export type DecisionEngineV3Response =
  DecisionResponse | DecisionDisabledResponse;

export interface DecisionEvidenceResponse {
  businessId: string;
  creativeId: string;
  asOf: string;
  engineVersion: string;
  flags: EngineV3Flags;
  dataHealth: DataHealth;
  scope: DecisionProfileScope;
  accountProfile: AccountDecisionProfile;
  decision: DecisionOutput;
  input: CreativeInput;
  funnelDiagnosis: FunnelDiagnosis | null;
  operatorResponse: OperatorResponseResult | null;
}
