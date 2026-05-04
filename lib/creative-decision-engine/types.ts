/**
 * Creative Decision Engine v3 - public type contract.
 * Real decision logic is implemented gate by gate in subsequent tasks;
 * this file freezes the input/output shape so UI and data layer can be
 * built in parallel.
 */

export const ENGINE_VERSION = "v3-2026-05-04-phase-3.7";

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
  | "rising"
  | "flat"
  | "falling"
  | "volatile"
  | "unknown";

/** Per-creative metric inputs the engine needs to decide. */
export interface CreativeInput {
  creativeId: string;
  creativeName: string | null;
  businessId: string;
  campaignId: string | null;

  // Scope
  objective: CampaignObjective | null;

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
  lastSpendAt: string | null;
  policyReason: string | null;
  dataFreshnessHours: number | null;

  // Fatigue (reused from V1 fatigue motor - value passed in, engine doesn't recompute)
  fatigueStatus: "none" | "watch" | "fatigued" | "unknown" | null;

  // Commercial truth (resolved upstream - engine consumes pre-resolved target)
  // If null the engine falls back through the truth resolution chain.
  targetRoas: number | null;
  breakevenRoas: number | null;

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
}

/** Per-business runtime configuration (Tier 2). */
export interface BusinessConfig {
  businessId: string;

  // Aggression preset -> scale ratio threshold
  aggression: AggressionPreset;
  scaleRatioThreshold: number;

  // Maturity gates
  maturitySpendThreshold: number;
  maturityPurchasesThreshold: number;

  // Cut maturity
  cutMaturitySpendThreshold: number;

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

  // Mature creative pool size (drives which baseline tier applies)
  matureCreativeCount: number;

  // ROAS distribution percentiles (null when sample too small)
  roasP75: number | null;
  roasP60: number | null;

  // Recent/total ROAS ratio P10 (drives refresh trend gate)
  refreshRatioP10: number | null;

  // CTR P10 (drives "low CTR" badge threshold)
  lowCtrP10: number | null;
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
    | "truth_global_default"
    | "missing_recent_data"
    | "weak_performance"
    | "stale_calibration"
    | "stale_lifecycle"
    | "stale_decision_context"
    | "lifecycle_unavailable"
    | "opportunity_window_open"
    | "opportunity_window_closing"
    | "past_peak_unclear_signal"
    | "volatile_trend";
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
  truth_account_baseline: { label: "Truth: account baseline", severity: "info" },
  truth_account_baseline_thin: {
    label: "Truth: thin account baseline",
    severity: "warning",
  },
  truth_global_default: {
    label: "Truth: global default",
    severity: "warning",
  },
  missing_recent_data: { label: "Recent data missing", severity: "warning" },
  weak_performance: { label: "Below target", severity: "warning" },
  stale_calibration: { label: "Calibration stale", severity: "warning" },
  stale_lifecycle: { label: "Lifecycle stale", severity: "warning" },
  stale_decision_context: {
    label: "Stale decision context",
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
};

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
  metrics: {
    spend: number;
    purchases: number;
    roas: number | null;
    recent7dRoas: number | null;
  };
  engineVersion: string;
  generatedAt: string;
}

/**
 * Data freshness tier for a single data layer (calibration, lifecycle, decisions).
 *
 * - `none`     -> data is recent (<36h since source max date), no UI signal needed
 * - `warning`  -> data is stale (36-72h), confidence reduced + UI badge shown
 * - `disabled` -> data is too stale (>72h), data-derived intelligence is disabled
 *                 (engine falls back to core gates only)
 */
export type StaleTier = "none" | "warning" | "disabled";

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
  businessId: string;
  asOf: string;
  engineVersion: string;
  dataSource: "warehouse" | "mock";
  dataHealth: DataHealth;
  decisions: DecisionOutput[];
}
