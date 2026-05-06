import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { META_DECISION_ENGINE_READY_WINDOW_DAYS } from "@/lib/meta/contract";
import {
  buildDecisionFreshness,
  classifyDecisionEntityState,
  classifyDecisionMateriality,
} from "@/lib/decision-trust/kernel";
import {
  buildDecisionEvidenceFloor,
  evaluateDecisionOpportunityQueue,
} from "@/lib/decision-trust/opportunity";
import {
  buildBidRegimePolicyFloor,
  buildCampaignFamilyPolicyFloor,
  buildDecisionPolicyCompare,
  buildDeploymentCompatibilityPolicyFloor,
  buildObjectiveFamilyPolicyFloor,
  compileDecisionPolicyExplanation,
} from "@/lib/decision-trust/policy";
import { compileDecisionTrust } from "@/lib/decision-trust/compiler";
import { buildDecisionSurfaceAuthority } from "@/lib/decision-trust/surface";
import { buildMetaCampaignLaneSignals } from "@/lib/meta/campaign-lanes";
import { buildAccountOperatingMode } from "@/lib/business-operating-mode";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import {
  assessMetaOperatorPolicy,
  inferMetaBudgetConstraint,
  type MetaEvidenceSource,
} from "@/lib/meta/operator-policy";
import type {
  AccountOperatingModePayload,
  BusinessCommercialTruthSnapshot,
  BusinessCountryEconomicsRow,
} from "@/src/types/business-commercial";
import type {
  OperatorAnalyticsWindow,
  OperatorDecisionSourceRowScope,
  OperatorDecisionSourceWindow,
  OperatorDecisionWindows,
  OperatorHistoricalMemory,
  OperatorPolicyAssessment,
} from "@/src/types/operator-decision";
import type {
  DecisionEvidenceFloor,
  DecisionOperatorDisposition,
  DecisionOpportunityQueueVerdict,
  DecisionPolicyExplanation,
  DecisionReadReliability,
  DecisionOpportunityQueueEligibility,
  DecisionSourceHealthEntry,
  DecisionSurfaceLane,
  DecisionSurfaceReadiness,
  DecisionTrustMetadata,
} from "@/src/types/decision-trust";

export const META_DECISION_OS_V1_CONTRACT = "meta-decision-os.v1" as const;

export const META_CAMPAIGN_ROLES = [
  "Promo / Clearance",
  "Catalog / DPA",
  "Retargeting",
  "Existing Customer / LTV",
  "Geo Expansion",
  "Prospecting Scale",
  "Prospecting Validation",
  "Prospecting Test",
] as const;
export type MetaCampaignRole = (typeof META_CAMPAIGN_ROLES)[number];

export const META_AD_SET_ACTION_TYPES = [
  "pause",
  "recover",
  "rebuild",
  "scale_budget",
  "reduce_budget",
  "hold",
  "duplicate_to_new_geo_cluster",
  "merge_into_pooled_geo",
  "switch_optimization",
  "tighten_bid",
  "broaden",
  "monitor_only",
] as const;
export type MetaAdSetActionType = (typeof META_AD_SET_ACTION_TYPES)[number];

export const META_GEO_ACTION_TYPES = [
  "scale",
  "validate",
  "pool",
  "isolate",
  "cut",
  "monitor",
] as const;
export type MetaGeoActionType = (typeof META_GEO_ACTION_TYPES)[number];

export type MetaDecisionImpact = "positive" | "negative" | "mixed" | "neutral";
export type MetaActionSize = "none" | "small" | "medium" | "large";
export type MetaDecisionPriority = "critical" | "high" | "medium" | "low";
export type MetaRiskLevel = "low" | "medium" | "high";
export type MetaCommercialFallbackMode = "configured_targets" | "conservative_fallback";
export type MetaPlacementAction = "keep_advantage_plus" | "exception_review";
export const META_OBJECTIVE_FAMILIES = [
  "sales",
  "catalog",
  "leads",
  "traffic",
  "awareness",
  "engagement",
  "unknown",
] as const;
export type MetaObjectiveFamily = (typeof META_OBJECTIVE_FAMILIES)[number];

export const META_BID_REGIMES = [
  "open",
  "cost_cap",
  "bid_cap",
  "roas_floor",
  "unknown",
] as const;
export type MetaBidRegime = (typeof META_BID_REGIMES)[number];

export const META_POLICY_DRIVERS = [
  "constraint_pressure",
  "roas_outperforming",
  "cpa_efficiency",
  "break_even_loss",
  "signal_density",
  "recent_change_cooldown",
  "mixed_config",
  "creative_fatigue",
  "winner_stability",
  "bid_regime_pressure",
  "geo_validation",
  "objective_upgrade",
  "degraded_truth_cap",
  "thin_signal",
] as const;
export type MetaPolicyDriver = (typeof META_POLICY_DRIVERS)[number];

export const META_WINNER_STATES = [
  "scale_candidate",
  "stable_no_touch",
  "guarded",
  "creative_refresh_required",
  "recovering",
  "not_a_winner",
  "degraded",
] as const;
export type MetaWinnerState = (typeof META_WINNER_STATES)[number];
export type MetaStrategyClass =
  | MetaAdSetActionType
  | "review_hold"
  | "review_cost_cap"
  | "creative_refresh_required"
  | "stable_no_touch";

export interface MetaDecisionEvidence {
  label: string;
  value: string;
  impact: MetaDecisionImpact;
}

export interface MetaGeoSourceFreshness {
  dataState: "ready" | "syncing" | "stale";
  lastSyncedAt: string | null;
  isPartial: boolean;
  verificationState: string | null;
  reason: string | null;
}

export interface MetaGeoSourceRow {
  key: string;
  label: string;
  spend: number;
  revenue: number;
  purchases: number;
  clicks: number;
  impressions: number;
}

export interface MetaGeoSourceSnapshot {
  rows: MetaGeoSourceRow[];
  freshness: MetaGeoSourceFreshness;
}

export interface MetaGeoMateriality {
  thinSignal: boolean;
  material: boolean;
  archiveContext: boolean;
}

export interface MetaGeoSupportingMetrics {
  spend: number;
  revenue: number;
  roas: number;
  purchases: number;
  clicks: number;
  impressions: number;
  spendShare: number;
}

export interface MetaGeoCommercialContext {
  serviceability: BusinessCountryEconomicsRow["serviceability"] | null;
  priorityTier: BusinessCountryEconomicsRow["priorityTier"] | null;
  scaleOverride: BusinessCountryEconomicsRow["scaleOverride"] | null;
  economicsMultiplier: number | null;
  marginModifier: number | null;
  countryEconomicsConfigured: boolean;
  countryEconomicsUpdatedAt: string | null;
  countryEconomicsSourceLabel: string | null;
}

export interface MetaDecisionPolicy {
  strategyClass: MetaStrategyClass;
  objectiveFamily: MetaObjectiveFamily;
  bidRegime: MetaBidRegime;
  primaryDriver: MetaPolicyDriver;
  secondaryDrivers: MetaPolicyDriver[];
  winnerState: MetaWinnerState;
  explanation?: DecisionPolicyExplanation;
}

export interface MetaCampaignDecision {
  campaignId: string;
  campaignName: string;
  status: string;
  role: MetaCampaignRole;
  primaryAction: MetaAdSetActionType;
  confidence: number;
  why: string;
  evidence: MetaDecisionEvidence[];
  guardrails: string[];
  noTouch: boolean;
  whatWouldChangeThisDecision: string[];
  adSetDecisionIds: string[];
  laneLabel: "Scaling" | "Validation" | "Test" | null;
  policy: MetaDecisionPolicy;
  trust: DecisionTrustMetadata;
  operatorPolicy?: OperatorPolicyAssessment;
  provenance: import("@/src/types/operator-decision").OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
  creativeCandidates?: {
    count: number;
    labels: string[];
    summary: string;
  } | null;
  missingCreativeAsk?: string[];
}

export interface MetaAdSetDecision {
  decisionId: string;
  adSetId: string;
  adSetName: string;
  campaignId: string;
  campaignName: string;
  actionType: MetaAdSetActionType;
  actionSize: MetaActionSize;
  priority: MetaDecisionPriority;
  confidence: number;
  reasons: string[];
  guardrails: string[];
  relatedCreativeNeeds: string[];
  relatedGeoContext: string[];
  supportingMetrics: {
    spend: number;
    revenue: number;
    roas: number;
    cpa: number | null;
    ctr: number | null;
    purchases: number;
    impressions: number;
    clicks: number;
    bidStrategyLabel: string | null;
    optimizationGoal: string | null;
    dailyBudget: number | null;
    lifetimeBudget: number | null;
    budgetLevel?: "campaign" | "adset" | null;
  };
  whatWouldChangeThisDecision: string[];
  noTouch: boolean;
  policy: MetaDecisionPolicy;
  trust: DecisionTrustMetadata;
  operatorPolicy?: OperatorPolicyAssessment;
  provenance: import("@/src/types/operator-decision").OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
  missingCreativeAsk?: string[];
}

export interface MetaBudgetShift {
  fromCampaignId: string;
  fromCampaignName: string;
  toCampaignId: string;
  toCampaignName: string;
  from: string;
  to: string;
  whyNow: string;
  riskLevel: MetaRiskLevel;
  expectedBenefit: string;
  suggestedMoveBand: string;
  confidence: number;
  guardrails: string[];
  provenance: import("@/src/types/operator-decision").OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
}

export interface MetaGeoDecision {
  geoKey: string;
  countryCode: string;
  label: string;
  action: MetaGeoActionType;
  queueEligible: boolean;
  confidence: number;
  why: string;
  evidence: MetaDecisionEvidence[];
  guardrails: string[];
  whatWouldChangeThisDecision: string[];
  clusterKey: string | null;
  clusterLabel: string | null;
  grouped: boolean;
  groupMemberCount: number;
  groupMemberLabels: string[];
  materiality: MetaGeoMateriality;
  supportingMetrics: MetaGeoSupportingMetrics;
  freshness: MetaGeoSourceFreshness;
  commercialContext: MetaGeoCommercialContext;
  trust: DecisionTrustMetadata;
  provenance: import("@/src/types/operator-decision").OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
}

export interface MetaPlacementAnomaly {
  placementKey: string;
  label: string;
  action: MetaPlacementAction;
  confidence: number;
  note: string;
  evidence: MetaDecisionEvidence[];
  whatWouldChangeThisDecision: string[];
  provenance: import("@/src/types/operator-decision").OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
}

export interface MetaNoTouchItem {
  entityType: "campaign" | "adset" | "geo";
  entityId: string;
  label: string;
  reason: string;
  confidence: number;
  guardrails: string[];
}

export interface MetaCommercialTruthCoverage {
  mode: MetaCommercialFallbackMode;
  targetPackConfigured: boolean;
  countryEconomicsConfigured: boolean;
  promoCalendarConfigured: boolean;
  operatingConstraintsConfigured: boolean;
  missingInputs: string[];
  notes: string[];
  summary?: import("@/src/types/business-commercial").BusinessCommercialCoverageSummary;
}

export interface MetaWinnerScaleCandidate {
  candidateId: string;
  campaignId: string;
  campaignName: string;
  adSetId: string;
  adSetName: string;
  confidence: number;
  why: string;
  suggestedMoveBand: string;
  evidence: MetaDecisionEvidence[];
  guardrails: string[];
  supportingMetrics: {
    spend: number;
    revenue: number;
    roas: number;
    cpa: number | null;
    ctr: number | null;
    purchases: number;
    dailyBudget: number | null;
    bidStrategyLabel: string | null;
    optimizationGoal: string | null;
  };
  policy: MetaDecisionPolicy;
}

export type MetaOpportunityKind =
  | "geo"
  | "campaign_winner_scale"
  | "adset_winner_scale"
  | "protected_winner";

export interface MetaOpportunityBoardItem {
  opportunityId: string;
  kind: MetaOpportunityKind;
  title: string;
  summary: string;
  recommendedAction: string;
  confidence: number;
  queue: DecisionOpportunityQueueEligibility;
  eligibilityTrace: DecisionOpportunityQueueEligibility["eligibilityTrace"];
  evidenceFloors: DecisionEvidenceFloor[];
  tags: string[];
  trust: DecisionTrustMetadata;
  source: {
    entityType: "campaign" | "adset" | "geo";
    entityId: string;
    groupKey: string | null;
  };
  relatedEntities: Array<{
    type: "campaign" | "adset" | "geo";
    id: string;
    label: string;
  }>;
  creativeCandidates?: string[];
  missingCreativeAsk?: string[];
  queueVerdict?: DecisionOpportunityQueueVerdict;
}

export interface MetaDecisionOsSummary {
  todayPlanHeadline: string;
  todayPlan: string[];
  budgetShiftSummary: string;
  noTouchSummary: string;
  winnerScaleSummary: {
    candidateCount: number;
    protectedCount: number;
    headline: string;
  };
  operatingMode: {
    currentMode: string;
    recommendedMode: string;
    confidence: number;
  } | null;
  confidence: number;
  sourceHealth: DecisionSourceHealthEntry[];
  readReliability: DecisionReadReliability;
  surfaceSummary: {
    actionCoreCount: number;
    watchlistCount: number;
    archiveCount: number;
    degradedCount: number;
    profitableTruthCappedCount?: number;
  };
  readiness?: DecisionSurfaceReadiness;
  opportunitySummary: {
    totalCount: number;
    queueEligibleCount: number;
    geoCount: number;
    winnerScaleCount: number;
    protectedCount: number;
    headline: string;
  };
  geoSummary: {
    actionCoreCount: number;
    watchlistCount: number;
    queuedCount: number;
    pooledClusterCount: number;
    sourceFreshness: MetaGeoSourceFreshness;
    countryEconomics: {
      configured: boolean;
      updatedAt: string | null;
      sourceLabel: string | null;
    };
  };
}

export interface MetaDecisionOsV1Response {
  contractVersion: typeof META_DECISION_OS_V1_CONTRACT;
  generatedAt: string;
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsWindow: OperatorAnalyticsWindow;
  decisionWindows: OperatorDecisionWindows;
  historicalMemory: OperatorHistoricalMemory;
  decisionAsOf: string;
  summary: MetaDecisionOsSummary;
  campaigns: MetaCampaignDecision[];
  adSets: MetaAdSetDecision[];
  budgetShifts: MetaBudgetShift[];
  geoDecisions: MetaGeoDecision[];
  placementAnomalies: MetaPlacementAnomaly[];
  noTouchList: MetaNoTouchItem[];
  winnerScaleCandidates: MetaWinnerScaleCandidate[];
  opportunityBoard: MetaOpportunityBoardItem[];
  commercialTruthCoverage: MetaCommercialTruthCoverage;
  authority?: import("@/src/types/decision-trust").DecisionSurfaceAuthority;
}

export interface BuildMetaDecisionOsInput {
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsStartDate?: string;
  analyticsEndDate?: string;
  analyticsWindow?: OperatorAnalyticsWindow;
  decisionWindows?: OperatorDecisionWindows;
  historicalMemory?: OperatorHistoricalMemory;
  decisionAsOf?: string;
  evidenceSource?: MetaEvidenceSource;
  campaigns: MetaCampaignRow[];
  adSets: MetaAdSetData[];
  breakdowns: Pick<MetaBreakdownsResponse, "location" | "placement"> | null;
  geoSource?: MetaGeoSourceSnapshot | null;
  commercialTruth: BusinessCommercialTruthSnapshot;
}

interface TargetThresholds {
  targetRoas: number;
  breakEvenRoas: number;
  targetCpa: number;
  breakEvenCpa: number;
  mode: MetaCommercialFallbackMode;
}

interface CampaignRoleDecision {
  role: MetaCampaignRole;
  confidence: number;
  why: string;
}

interface GeoConstraint {
  countryCode: string;
  economicsMultiplier: number | null;
  marginModifier: number | null;
  serviceability: BusinessCountryEconomicsRow["serviceability"];
  priorityTier: BusinessCountryEconomicsRow["priorityTier"];
  scaleOverride: BusinessCountryEconomicsRow["scaleOverride"];
}

interface MetaDecisionProvenanceContext {
  businessId: string;
  decisionAsOf: string;
  analyticsWindow: OperatorAnalyticsWindow;
  reportingRange: {
    startDate: string;
    endDate: string;
  };
  sourceWindow: OperatorDecisionSourceWindow;
  evidenceSource: MetaEvidenceSource;
}

const ACTION_PRIORITY: Record<MetaAdSetActionType, number> = {
  pause: 0,
  recover: 1,
  rebuild: 2,
  scale_budget: 3,
  reduce_budget: 4,
  hold: 5,
  duplicate_to_new_geo_cluster: 6,
  merge_into_pooled_geo: 7,
  switch_optimization: 8,
  tighten_bid: 9,
  broaden: 10,
  monitor_only: 11,
};

function clampConfidence(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.99, Math.max(0.2, Number(value.toFixed(2))));
}

function round(value: number, precision = 2) {
  return Number(value.toFixed(precision));
}

function average(values: number[]) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (valid.length === 0) return 0;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function formatCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `$${round(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatRatio(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${round(value)}x`;
}

function formatPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "Unavailable";
  return `${round(value)}%`;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function uniqueValues<T>(values: T[]) {
  return Array.from(new Set(values));
}

function classifyObjectiveFamily(input: {
  campaign: MetaCampaignRow | null;
  adSet: MetaAdSetData | null;
  campaignRole?: MetaCampaignRole | null;
}): MetaObjectiveFamily {
  if (input.campaignRole === "Catalog / DPA") return "catalog";
  const source = normalizeText(
    [
      input.campaign?.objective,
      input.campaign?.optimizationGoal,
      input.adSet?.optimizationGoal,
      input.adSet?.name,
      input.campaign?.name,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (
    source.includes("catalog") ||
    source.includes("dpa") ||
    source.includes("product set") ||
    source.includes("shopping")
  ) {
    return "catalog";
  }
  if (
    source.includes("purchase") ||
    source.includes("sales") ||
    source.includes("roas") ||
    source.includes("checkout") ||
    source.includes("value")
  ) {
    return "sales";
  }
  if (source.includes("lead") || source.includes("registration")) return "leads";
  if (
    source.includes("traffic") ||
    source.includes("landing page") ||
    source.includes("click") ||
    source.includes("link")
  ) {
    return "traffic";
  }
  if (
    source.includes("awareness") ||
    source.includes("reach") ||
    source.includes("brand")
  ) {
    return "awareness";
  }
  if (
    source.includes("engagement") ||
    source.includes("message") ||
    source.includes("messaging") ||
    source.includes("video")
  ) {
    return "engagement";
  }
  return "unknown";
}

function classifyBidRegime(input: {
  campaign: MetaCampaignRow | null;
  adSet: MetaAdSetData | null;
}): MetaBidRegime {
  const source = normalizeText(
    [
      input.adSet?.bidStrategyType,
      input.adSet?.bidStrategyLabel,
      input.campaign?.bidStrategyType,
      input.campaign?.bidStrategyLabel,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (source.includes("cost cap")) return "cost_cap";
  if (source.includes("bid cap")) return "bid_cap";
  if (source.includes("roas")) return "roas_floor";
  if (
    input.adSet?.manualBidAmount != null ||
    input.campaign?.manualBidAmount != null
  ) {
    return "bid_cap";
  }
  if (source.includes("lowest cost") || source.includes("highest volume")) {
    return "open";
  }
  return source.length > 0 ? "unknown" : "open";
}

function buildSuggestedMoveBand(actionSize: MetaActionSize) {
  if (actionSize === "large") return "15-25% of current budget load";
  if (actionSize === "medium") return "10-15% of current budget load";
  if (actionSize === "small") return "5-10% of current budget load";
  return "Hold current budget until more clean headroom appears";
}

function mapStrategyClassToActionType(
  strategyClass: MetaStrategyClass,
): MetaAdSetActionType {
  if (
    strategyClass === "review_hold" ||
    strategyClass === "creative_refresh_required" ||
    strategyClass === "stable_no_touch"
  ) {
    return "hold";
  }
  if (strategyClass === "review_cost_cap") return "tighten_bid";
  return strategyClass;
}

function determinePriorityFromAction(
  actionType: MetaAdSetActionType,
  strategyClass: MetaStrategyClass,
  confidence: number,
): MetaDecisionPriority {
  if (actionType === "pause") return "critical";
  if (
    actionType === "reduce_budget" ||
    actionType === "recover" ||
    actionType === "rebuild"
  ) {
    return "high";
  }
  if (
    actionType === "scale_budget" ||
    strategyClass === "review_cost_cap" ||
    strategyClass === "creative_refresh_required"
  ) {
    return confidence >= 0.78 ? "high" : "medium";
  }
  if (actionType === "monitor_only") return "low";
  return "medium";
}

const META_STRATEGY_AGGRESSION_RANK: Record<MetaStrategyClass, number> = {
  review_hold: 0,
  stable_no_touch: 0,
  creative_refresh_required: 1,
  monitor_only: 1,
  tighten_bid: 2,
  review_cost_cap: 2,
  duplicate_to_new_geo_cluster: 2,
  merge_into_pooled_geo: 2,
  switch_optimization: 2,
  broaden: 2,
  hold: 2,
  reduce_budget: 2,
  recover: 3,
  rebuild: 3,
  scale_budget: 4,
  pause: 4,
};

function isConservativeMetaPolicyCutover(
  baselineStrategyClass: MetaStrategyClass,
  candidateStrategyClass: MetaStrategyClass,
) {
  return (
    META_STRATEGY_AGGRESSION_RANK[candidateStrategyClass] <=
    META_STRATEGY_AGGRESSION_RANK[baselineStrategyClass]
  );
}

function buildMetaPolicyLadder(input: {
  baselineStrategyClass: MetaStrategyClass;
  baselineActionSize: MetaActionSize;
  baselinePrimaryDriver: MetaPolicyDriver;
  baselineWinnerState: MetaWinnerState;
  baselineReason: string;
  objectiveFamily: MetaObjectiveFamily;
  bidRegime: MetaBidRegime;
  campaignRole: MetaCampaignRole;
  fallbackDisposition: DecisionOperatorDisposition | null;
  operatingMode: AccountOperatingModePayload | null;
  targetMet: boolean;
  lowSignal: boolean;
  recentChange: boolean;
  mixedConfig: boolean;
  geoRole: boolean;
  stableProtectedWinner: boolean;
  creativeFatigueCandidate: boolean;
  constrainedBidRegime: boolean;
  bidRegimePressure: boolean;
}) {
  const objectiveBlocked =
    input.baselineStrategyClass === "scale_budget" &&
    (input.objectiveFamily === "awareness" || input.objectiveFamily === "traffic");
  const objectiveWatch =
    input.baselineStrategyClass === "scale_budget" &&
    (input.objectiveFamily === "engagement" || input.objectiveFamily === "leads");
  const objectiveFloor = buildObjectiveFamilyPolicyFloor({
    current: input.objectiveFamily,
    required:
      input.baselineStrategyClass === "scale_budget"
        ? "sales, catalog, or proven lead efficiency for scale promotion"
        : "policy-compatible objective",
    status: objectiveBlocked ? "blocked" : objectiveWatch ? "watch" : "met",
    reason: objectiveBlocked
      ? "Upper-funnel objective families cap this ladder at broaden or hold instead of direct scale."
      : objectiveWatch
        ? "Lead and engagement families need stronger proof before using the full scale ladder."
        : null,
  });
  const bidFloor = buildBidRegimePolicyFloor({
    current: input.bidRegime,
    required:
      input.baselineStrategyClass === "scale_budget"
        ? "open or clearly outperforming capped delivery"
        : "bid regime aligned with the next move",
    status: input.bidRegimePressure
      ? "blocked"
      : input.constrainedBidRegime && input.baselineStrategyClass === "scale_budget"
        ? "watch"
        : "met",
    reason: input.bidRegimePressure
      ? "The current bid guardrail is the first lever that needs review before broader action."
      : input.constrainedBidRegime && input.baselineStrategyClass === "scale_budget"
        ? "Capped delivery can scale, but only while the guardrail remains comfortably inside target."
        : null,
  });
  const campaignFamilyFloor = buildCampaignFamilyPolicyFloor({
    current: input.campaignRole,
    required: "family matched to the active move ladder",
    status: input.stableProtectedWinner
      ? "met"
      : input.geoRole && input.lowSignal
        ? "watch"
        : "met",
    reason:
      input.geoRole && input.lowSignal
        ? "Geo expansion stays on a validation ladder until signal becomes material."
        : null,
  });
  const deploymentFloor = buildDeploymentCompatibilityPolicyFloor({
    current: input.mixedConfig
      ? "mixed_config"
      : input.recentChange
        ? "cooldown"
        : "ready",
    required: "clean structure with no fresh config churn",
    status: input.mixedConfig ? "blocked" : input.recentChange ? "watch" : "met",
    reason: input.mixedConfig
      ? "Mixed budget, bid, or optimization config blocks the candidate ladder."
      : input.recentChange
        ? "Recent edits keep the candidate ladder in compare mode until the signal settles."
        : null,
  });

  let candidateStrategyClass = input.baselineStrategyClass;
  let candidateActionSize = input.baselineActionSize;
  let candidatePrimaryDriver = input.baselinePrimaryDriver;
  let candidateWinnerState = input.baselineWinnerState;
  let candidateReason = input.baselineReason;
  let candidateGuardrail: string | null = null;
  let actionCeiling: string | null = null;

  if (input.fallbackDisposition) {
    candidateStrategyClass = "review_hold";
    candidateActionSize = "none";
    candidatePrimaryDriver = "degraded_truth_cap";
    candidateWinnerState =
      input.baselineWinnerState === "not_a_winner" ? "not_a_winner" : "degraded";
    candidateReason =
      "Shared policy ladder keeps this in compare-safe hold because commercial truth is degraded.";
    candidateGuardrail =
      "Restore commercial truth before enabling the more aggressive branch of this ladder.";
    actionCeiling = "Hold and review only until missing truth inputs are restored.";
  } else if (input.creativeFatigueCandidate) {
    candidateStrategyClass = "creative_refresh_required";
    candidateActionSize = "none";
    candidatePrimaryDriver = "creative_fatigue";
    candidateWinnerState = "creative_refresh_required";
    candidateReason =
      "Shared policy ladder routes this lane into creative refresh before any further scale.";
    candidateGuardrail =
      "Refresh creative supply before stacking budget, bid, and structure changes together.";
    actionCeiling = "Refresh only until fresh creative evidence clears the fatigue cap.";
  } else if (input.stableProtectedWinner) {
    candidateStrategyClass = "stable_no_touch";
    candidateActionSize = "none";
    candidatePrimaryDriver = "winner_stability";
    candidateWinnerState = "stable_no_touch";
    candidateReason =
      "Shared policy ladder keeps this winner on a protected no-touch path.";
    candidateGuardrail =
      "Leave the stable winner untouched unless a separate proven constraint reopens it.";
    actionCeiling = "No-touch only while the stable winner remains efficient and structurally clean.";
  } else if (deploymentFloor.status === "blocked") {
    candidateStrategyClass = "review_hold";
    candidateActionSize = "none";
    candidatePrimaryDriver = "mixed_config";
    candidateWinnerState = "guarded";
    candidateReason =
      "Shared policy ladder blocks cutover because structure readiness is not clean enough yet.";
    candidateGuardrail =
      "Clear mixed config before allowing broader budget or bid actions.";
    actionCeiling = "Review or rebuild only until structure readiness is clean.";
  } else if (objectiveFloor.status === "blocked") {
    candidateStrategyClass = "broaden";
    candidateActionSize = "small";
    candidatePrimaryDriver = "signal_density";
    candidateWinnerState = "guarded";
    candidateReason =
      "Shared policy ladder caps upper-funnel efficiency at controlled broadening instead of direct scale.";
    candidateGuardrail =
      "Broaden in small steps and verify the current winner path is not simply budget-limited.";
    actionCeiling = "Broaden or validate only; do not jump straight into the lower-funnel scale ladder.";
  } else if (
    input.baselineStrategyClass === "scale_budget" &&
    bidFloor.status === "blocked"
  ) {
    candidateStrategyClass = "review_cost_cap";
    candidateActionSize = "small";
    candidatePrimaryDriver = "bid_regime_pressure";
    candidateWinnerState = "guarded";
    candidateReason =
      "Shared policy ladder sends this through bid-regime review before adding broader scale pressure.";
    candidateGuardrail =
      "Review the bid guardrail before changing multiple levers in the same move.";
    actionCeiling = "Bid review first, then reopen the scale ladder only if headroom remains clean.";
  }

  const compare = buildDecisionPolicyCompare({
    baselineAction: input.baselineStrategyClass,
    candidateAction: candidateStrategyClass,
    allowCandidate: isConservativeMetaPolicyCutover(
      input.baselineStrategyClass,
      candidateStrategyClass,
    ),
    candidateReason,
    baselineReason:
      "Shared policy ladder stayed in compare mode because the candidate branch would have been more aggressive than the current baseline.",
  });

  return {
    strategyClass:
      compare.selectedAction === input.baselineStrategyClass
        ? input.baselineStrategyClass
        : candidateStrategyClass,
    actionSize:
      compare.selectedAction === input.baselineStrategyClass
        ? input.baselineActionSize
        : candidateActionSize,
    primaryDriver:
      compare.selectedAction === input.baselineStrategyClass
        ? input.baselinePrimaryDriver
        : candidatePrimaryDriver,
    winnerState:
      compare.selectedAction === input.baselineStrategyClass
        ? input.baselineWinnerState
        : candidateWinnerState,
    selectedReason:
      compare.selectedAction === input.baselineStrategyClass
        ? input.baselineReason
        : candidateReason,
    selectedGuardrail:
      compare.selectedAction === input.baselineStrategyClass
        ? null
        : candidateGuardrail,
    explanation: compileDecisionPolicyExplanation({
      summary:
        compare.selectedAction === input.baselineStrategyClass
          ? `Shared policy ladder kept ${input.baselineStrategyClass.replaceAll("_", " ")} active for this Meta lane.`
          : `Shared policy ladder promoted ${candidateStrategyClass.replaceAll("_", " ")} as the active Meta branch.`,
      axes: [
        objectiveFloor,
        bidFloor,
        campaignFamilyFloor,
        deploymentFloor,
      ],
      degradedReasons:
        input.fallbackDisposition || input.operatingMode?.missingInputs?.length
          ? input.operatingMode?.missingInputs ?? []
          : [],
      actionCeiling,
      protectedWinnerHandling: input.stableProtectedWinner
        ? "Stable winners stay visible as protected context and should not be mixed with broader edits."
        : null,
      fatigueOrComeback: input.creativeFatigueCandidate
        ? "Creative fatigue stays ahead of spend escalation in the shared ladder."
        : null,
      supplyPlanning:
        input.creativeFatigueCandidate || input.baselineStrategyClass === "creative_refresh_required"
          ? "Refresh creative supply before re-opening the scale ladder."
          : null,
      compare,
    }),
  };
}

function matchesAnyKeyword(source: string, keywords: string[]) {
  return keywords.some((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i");
    return pattern.test(source);
  });
}

function toCountryCode(label: string | null | undefined) {
  const normalized = String(label ?? "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function isRecentIso(input: string | null | undefined, referenceIso: string, days = 3) {
  if (!input) return false;
  const timestamp = new Date(input).getTime();
  const reference = new Date(`${referenceIso}T23:59:59.999Z`).getTime();
  if (!Number.isFinite(timestamp) || !Number.isFinite(reference)) return false;
  return reference - timestamp <= days * 86_400_000;
}

function inclusiveWindowDays(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 1;
  return Math.max(1, Math.round((end - start) / 86_400_000) + 1);
}

function isPromoActiveOnDate(
  startDate: string,
  endDate: string,
  asOfDate: string,
) {
  return startDate <= asOfDate && endDate >= asOfDate;
}

function determineThresholds(snapshot: BusinessCommercialTruthSnapshot): TargetThresholds {
  const targetPack = snapshot.targetPack;
  if (
    targetPack?.targetRoas != null ||
    targetPack?.breakEvenRoas != null ||
    targetPack?.targetCpa != null ||
    targetPack?.breakEvenCpa != null
  ) {
    return {
      targetRoas: targetPack?.targetRoas ?? 2.6,
      breakEvenRoas: targetPack?.breakEvenRoas ?? 1.8,
      targetCpa: targetPack?.targetCpa ?? 42,
      breakEvenCpa: targetPack?.breakEvenCpa ?? 58,
      mode: "configured_targets",
    };
  }
  return {
    targetRoas: 2.5,
    breakEvenRoas: 1.8,
    targetCpa: 40,
    breakEvenCpa: 55,
    mode: "conservative_fallback",
  };
}

function collectCommercialTruthCoverage(snapshot: BusinessCommercialTruthSnapshot): MetaCommercialTruthCoverage {
  const thresholds = determineThresholds(snapshot);
  const missingInputs: string[] = [];
  if (!snapshot.targetPack) missingInputs.push("target_pack");
  if (snapshot.promoCalendar.length === 0) missingInputs.push("promo_calendar");
  if (!snapshot.operatingConstraints) missingInputs.push("operating_constraints");

  return {
    mode: thresholds.mode,
    targetPackConfigured: Boolean(snapshot.targetPack),
    countryEconomicsConfigured: snapshot.countryEconomics.length > 0,
    promoCalendarConfigured: snapshot.promoCalendar.length > 0,
    operatingConstraintsConfigured: Boolean(snapshot.operatingConstraints),
    missingInputs,
    summary: snapshot.coverage,
    notes:
      thresholds.mode === "configured_targets"
        ? [
            "Commercial targets are configured, so decision aggressiveness can scale to business-specific thresholds.",
            ...(snapshot.countryEconomics.length === 0
              ? ["Country economics are not configured, so all GEOs use the global cost structure."]
              : []),
          ]
        : [
            "Commercial targets are missing, so Decision OS is using conservative fallback thresholds.",
            "Safe actions stay preferred while missing truth lowers confidence.",
            ...(snapshot.countryEconomics.length === 0
              ? ["Country economics are not configured, so all GEOs use the global cost structure."]
              : []),
          ],
  };
}

function classifyCampaignRole(input: {
  campaign: MetaCampaignRow;
  laneLabel: "Scaling" | "Validation" | "Test" | null;
  activePromoNames: string[];
}): CampaignRoleDecision {
  const source = `${input.campaign.name} ${input.campaign.objective ?? ""} ${input.campaign.optimizationGoal ?? ""}`.toLowerCase();
  const promoKeywords = ["promo", "promotion", "sale", "clearance", "summer gear", "discount", "offer"];
  const catalogKeywords = ["catalog", "dpa", "product set", "shopping", "advantage+ shopping"];
  const retargetingKeywords = ["remarketing", "retarget", "retargeting", "visitor", "cart", "atc", "vc", "viewcontent"];
  const ltvKeywords = ["ltv", "repeat", "existing", "customer", "crm", "vip", "purchaser"];
  const geoKeywords = ["geo", "intl", "international", "expansion", "uk", "ca", "au", "eu", "mena"];

  if (matchesAnyKeyword(source, promoKeywords) || input.activePromoNames.some((name) => source.includes(name))) {
    return {
      role: "Promo / Clearance",
      confidence: 0.92,
      why: "Campaign naming or active promo overlap indicates this is a promo-driven lane.",
    };
  }
  if (matchesAnyKeyword(source, catalogKeywords)) {
    return {
      role: "Catalog / DPA",
      confidence: 0.88,
      why: "Campaign naming indicates catalog or DPA-style delivery.",
    };
  }
  if (matchesAnyKeyword(source, retargetingKeywords)) {
    return {
      role: "Retargeting",
      confidence: 0.9,
      why: "Campaign naming indicates retargeting or remarketing intent.",
    };
  }
  if (matchesAnyKeyword(source, ltvKeywords)) {
    return {
      role: "Existing Customer / LTV",
      confidence: 0.89,
      why: "Campaign naming indicates existing-customer or LTV intent.",
    };
  }
  if (matchesAnyKeyword(source, geoKeywords)) {
    return {
      role: "Geo Expansion",
      confidence: 0.86,
      why: "Campaign naming suggests this lane is being used for geo expansion.",
    };
  }
  if (input.laneLabel === "Scaling") {
    return {
      role: "Prospecting Scale",
      confidence: 0.84,
      why: "Scaling lane signal places this campaign in the prospecting scale role.",
    };
  }
  if (input.laneLabel === "Test") {
    return {
      role: "Prospecting Test",
      confidence: 0.8,
      why: "Lane analysis marks this as an exploratory or low-signal prospecting test.",
    };
  }
  if (input.laneLabel === "Validation") {
    return {
      role: "Prospecting Validation",
      confidence: 0.82,
      why: "Lane analysis marks this as a validation lane.",
    };
  }
  return {
    role: "Prospecting Validation",
    confidence: 0.58,
    why: "No stronger role signal exists, so this falls back to prospecting validation with reduced confidence.",
  };
}

function buildOperatingModeSummary(input: BuildMetaDecisionOsInput): AccountOperatingModePayload | null {
  try {
    return buildAccountOperatingMode({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      analyticsWindow: input.analyticsWindow,
      decisionWindows: input.decisionWindows,
      historicalMemory: input.historicalMemory,
      decisionAsOf: input.decisionAsOf,
      snapshot: input.commercialTruth,
      campaigns: { rows: input.campaigns },
      breakdowns: input.breakdowns
        ? ({
            age: [],
            location: input.breakdowns.location,
            placement: input.breakdowns.placement,
            budget: { campaign: [], adset: [] },
            audience: { available: false },
            products: { available: false },
          } satisfies MetaBreakdownsResponse)
        : null,
    });
  } catch {
    return null;
  }
}

function isInactiveMetaStatus(status: string | null | undefined) {
  const normalized = normalizeText(status);
  return normalized.length > 0 && normalized !== "active";
}

function isArchiveMetaAdSet(adSet: MetaAdSetData) {
  const entityState = classifyDecisionEntityState({
    status: adSet.status,
    spend: adSet.spend,
  });
  if (entityState !== "active") return true;
  return (
    classifyDecisionMateriality({
      spend: adSet.spend,
      purchases: adSet.purchases,
      impressions: adSet.impressions,
      archiveSpendThreshold: 60,
      archiveImpressionThreshold: 3_000,
      thinSignalSpendThreshold: 120,
      thinSignalPurchaseThreshold: 3,
    }) === "immaterial"
  );
}

function isArchiveMetaCampaign(campaign: MetaCampaignRow) {
  const entityState = classifyDecisionEntityState({
    status: campaign.status,
    spend: campaign.spend,
  });
  if (entityState !== "active") return true;
  return (
    classifyDecisionMateriality({
      spend: campaign.spend,
      purchases: campaign.purchases,
      impressions: campaign.impressions,
      archiveSpendThreshold: 90,
      archiveImpressionThreshold: 8_000,
      thinSignalSpendThreshold: 180,
      thinSignalPurchaseThreshold: 4,
    }) === "immaterial"
  );
}

function findGeoConstraint(
  snapshot: BusinessCommercialTruthSnapshot,
  countryCode: string | null,
): GeoConstraint | null {
  if (!countryCode) return null;
  const row = snapshot.countryEconomics.find(
    (candidate) => candidate.countryCode.toUpperCase() === countryCode,
  );
  if (!row) return null;
  return {
    countryCode,
    economicsMultiplier: row.economicsMultiplier,
    marginModifier: row.marginModifier,
    serviceability: row.serviceability,
    priorityTier: row.priorityTier,
    scaleOverride: row.scaleOverride,
  };
}

function formatPriorityTierLabel(
  value: BusinessCountryEconomicsRow["priorityTier"] | null,
) {
  if (!value) return "unconfigured";
  return value.replace("_", " ");
}

function buildGeoClusterKey(input: {
  action: Extract<MetaGeoActionType, "pool" | "validate" | "monitor">;
  priorityTier: BusinessCountryEconomicsRow["priorityTier"] | null;
  serviceability: BusinessCountryEconomicsRow["serviceability"] | null;
  truthState: DecisionTrustMetadata["truthState"];
}) {
  return [
    input.action,
    input.priorityTier ?? "unconfigured",
    input.serviceability ?? "unknown",
    input.truthState,
  ].join(":");
}

function buildGeoClusterLabel(input: {
  action: Extract<MetaGeoActionType, "pool" | "validate" | "monitor">;
  priorityTier: BusinessCountryEconomicsRow["priorityTier"] | null;
  serviceability: BusinessCountryEconomicsRow["serviceability"] | null;
}) {
  return `${input.action} • ${formatPriorityTierLabel(input.priorityTier)} • ${input.serviceability ?? "unknown serviceability"}`;
}

function resolveDefaultGeoSourceFreshness(
  input: Pick<BuildMetaDecisionOsInput, "breakdowns">,
): MetaGeoSourceFreshness {
  const rowCount = input.breakdowns?.location.length ?? 0;
  return {
    dataState: rowCount > 0 ? "ready" : "stale",
    lastSyncedAt: null,
    isPartial: false,
    verificationState: null,
    reason:
      rowCount > 0
        ? null
        : "Country breakdown source did not return rows for the current decision window.",
  };
}

function buildMetaDecisionProvenance(input: {
  businessId: string;
  decisionAsOf: string;
  analyticsWindow: OperatorAnalyticsWindow;
  reportingRange: {
    startDate: string;
    endDate: string;
  };
  sourceWindow: OperatorDecisionSourceWindow;
  sourceRowScope: OperatorDecisionSourceRowScope;
  sourceDecisionId: string;
  recommendedAction: string;
  evidence: MetaDecisionEvidence[];
  hashEvidence?: unknown;
}) {
  return buildOperatorDecisionProvenance({
    businessId: input.businessId,
    decisionAsOf: input.decisionAsOf,
    analyticsWindow: input.analyticsWindow,
    reportingRange: input.reportingRange,
    sourceWindow: input.sourceWindow,
    sourceRowScope: input.sourceRowScope,
    sourceDecisionId: input.sourceDecisionId,
    recommendedAction: input.recommendedAction,
    evidence: input.evidence,
    hashEvidence: input.hashEvidence,
  });
}

function buildGeoAction(input: {
  row: MetaGeoSourceRow;
  accountRoas: number;
  snapshot: BusinessCommercialTruthSnapshot;
  thresholds: TargetThresholds;
  geoFreshness: MetaGeoSourceFreshness;
  totalGeoSpend: number;
  provenanceContext: MetaDecisionProvenanceContext;
}): MetaGeoDecision {
  const countryCode = toCountryCode(input.row.label) ?? input.row.key.toUpperCase();
  const roas = input.row.spend > 0 ? input.row.revenue / input.row.spend : 0;
  const constraint = findGeoConstraint(input.snapshot, countryCode);
  const thinSignal = input.row.spend < 250 || input.row.purchases < 6;
  const archiveContext =
    input.row.spend <= 0 ||
    (input.row.spend < 120 && input.row.purchases === 0);
  const material = !archiveContext && (input.row.spend >= 120 || input.row.purchases > 0);
  const strong = roas >= input.thresholds.targetRoas && input.row.purchases >= 10;
  const weak = roas > 0 && roas < input.thresholds.breakEvenRoas && input.row.spend >= 200;
  let action: MetaGeoActionType = "monitor";
  let why = "Keep this geo under observation while more signal accumulates.";
  let confidence = 0.56;

  if (constraint?.serviceability === "blocked") {
    action = "cut";
    why = "Serviceability is blocked, so spend should not keep flowing here.";
    confidence = 0.95;
  } else if (constraint?.scaleOverride === "deprioritize") {
    action = "cut";
    why = "Commercial truth explicitly deprioritizes this GEO.";
    confidence = 0.88;
  } else if (constraint?.scaleOverride === "hold") {
    action = "monitor";
    why = "Commercial truth says hold, so this geo should be monitored rather than scaled.";
    confidence = 0.8;
  } else if (constraint?.scaleOverride === "prefer_scale" && strong) {
    action = "scale";
    why = "Commercial truth prefers scale here and current economics are strong enough to support it.";
    confidence = 0.88;
  } else if (constraint?.serviceability === "limited" && weak) {
    action = "cut";
    why = "Serviceability is limited and the current efficiency does not justify preserving spend.";
    confidence = 0.84;
  } else if (strong && input.row.spend >= 600) {
    action = constraint?.priorityTier === "tier_1" ? "isolate" : "scale";
    why =
      action === "isolate"
        ? "This GEO is winning with enough volume to justify its own isolated operating path."
        : "This GEO is outperforming the account and can take more controlled spend.";
    confidence = action === "isolate" ? 0.82 : 0.78;
  } else if (thinSignal && (constraint?.priorityTier === "tier_3" || !constraint)) {
    action = "pool";
    why = "Signal is thin, so this GEO belongs in a pooled validation cluster instead of a dedicated path.";
    confidence = 0.74;
  } else if (thinSignal) {
    action = "validate";
    why = "Signal is still thin, but not weak enough to cut. Validate before making a bigger move.";
    confidence = 0.68;
  } else if (weak) {
    action = "cut";
    why = "This GEO is below break-even with enough spend to justify a cut decision.";
    confidence = 0.8;
  }

  const degradedMissingTruth =
    input.thresholds.mode === "conservative_fallback";
  const watchlistAction = action === "monitor" || action === "pool" || action === "validate";
  const entityState = input.row.spend <= 0 ? "inactive" : "active";
  const materiality = archiveContext
    ? "immaterial"
    : thinSignal
      ? "thin_signal"
      : "material";
  const missingInputs = [
    ...(input.thresholds.mode === "conservative_fallback" ? ["target_pack"] : []),
  ];
  const trust = archiveContext
    ? compileDecisionTrust({
        surfaceLane: "archive_context",
        truthState: "inactive_or_immaterial",
        operatorDisposition: "archive_only",
        entityState,
        materiality,
        freshness: buildDecisionFreshness({
          status:
            input.geoFreshness.dataState === "ready"
              ? "fresh"
              : input.geoFreshness.isPartial
                ? "partial"
                : "stale",
          updatedAt: input.geoFreshness.lastSyncedAt,
          reason: input.geoFreshness.reason,
        }),
        reasons: [
          "Geo signal is inactive or immaterial for the live action core.",
          thinSignal ? "Thin-signal GEOs stay out of the default action core." : null,
        ],
      })
    : degradedMissingTruth
      ? compileDecisionTrust({
          surfaceLane:
            action === "scale" || action === "isolate" || watchlistAction
              ? "watchlist"
              : "action_core",
          truthState: "degraded_missing_truth",
          operatorDisposition:
            action === "scale" || action === "isolate"
              ? "profitable_truth_capped"
              : action === "cut"
                ? "review_reduce"
                : "monitor_low_truth",
          entityState,
          materiality,
          freshness: buildDecisionFreshness({
            status:
              input.geoFreshness.dataState === "ready"
                ? "fresh"
                : input.geoFreshness.isPartial
                  ? "partial"
                  : "stale",
            updatedAt: input.geoFreshness.lastSyncedAt,
            reason: input.geoFreshness.reason,
          }),
          missingInputs,
          reasons: [
            "Commercial truth is incomplete, so GEO actions stay trust-capped.",
            why,
          ],
        })
      : watchlistAction
        ? compileDecisionTrust({
            surfaceLane: "watchlist",
            truthState: "live_confident",
            operatorDisposition: "monitor_low_truth",
            entityState,
            materiality,
            freshness: buildDecisionFreshness({
              status:
                input.geoFreshness.dataState === "ready"
                  ? "fresh"
                  : input.geoFreshness.isPartial
                    ? "partial"
                    : "stale",
              updatedAt: input.geoFreshness.lastSyncedAt,
              reason: input.geoFreshness.reason,
            }),
            reasons: [why],
          })
        : compileDecisionTrust({
            surfaceLane: "action_core",
            truthState: "live_confident",
            operatorDisposition: "standard",
            entityState,
            materiality,
            freshness: buildDecisionFreshness({
              status:
                input.geoFreshness.dataState === "ready"
                  ? "fresh"
                  : input.geoFreshness.isPartial
                    ? "partial"
                    : "stale",
              updatedAt: input.geoFreshness.lastSyncedAt,
              reason: input.geoFreshness.reason,
            }),
            reasons: [why],
          });
  const queueEligible = material && trust.surfaceLane === "action_core";
  const clusterKey =
    action === "pool" || action === "validate" || action === "monitor"
      ? buildGeoClusterKey({
          action,
          priorityTier: constraint?.priorityTier ?? null,
          serviceability: constraint?.serviceability ?? null,
          truthState: trust.truthState,
        })
      : null;
  const clusterLabel =
    action === "pool" || action === "validate" || action === "monitor"
      ? buildGeoClusterLabel({
          action,
          priorityTier: constraint?.priorityTier ?? null,
          serviceability: constraint?.serviceability ?? null,
        })
      : null;
  const evidence: MetaDecisionEvidence[] = [
    { label: "Spend", value: formatCurrency(input.row.spend), impact: "neutral" },
    {
      label: "ROAS",
      value: formatRatio(roas),
      impact:
        roas >= input.thresholds.targetRoas
          ? "positive"
          : roas < input.thresholds.breakEvenRoas
            ? "negative"
            : "mixed",
    },
    {
      label: "Commercial override",
      value: constraint ? `${constraint.serviceability} / ${constraint.scaleOverride}` : "None",
      impact:
        constraint?.scaleOverride === "prefer_scale"
          ? "positive"
          : constraint?.scaleOverride === "deprioritize"
            ? "negative"
            : "neutral",
    },
  ];
  const provenance = buildMetaDecisionProvenance({
    businessId: input.provenanceContext.businessId,
    decisionAsOf: input.provenanceContext.decisionAsOf,
    analyticsWindow: input.provenanceContext.analyticsWindow,
    reportingRange: input.provenanceContext.reportingRange,
    sourceWindow: input.provenanceContext.sourceWindow,
    sourceRowScope: {
      system: "meta",
      entityType: "geo",
      entityId: `${countryCode}:${action}`,
    },
    sourceDecisionId: `${countryCode}:${action}`,
    recommendedAction: action,
    evidence,
    hashEvidence: {
      spend: input.row.spend,
      revenue: input.row.revenue,
      roas,
      accountRoas: input.accountRoas,
      targetRoas: input.thresholds.targetRoas,
      breakEvenRoas: input.thresholds.breakEvenRoas,
      purchases: input.row.purchases,
      clicks: input.row.clicks,
      impressions: input.row.impressions,
      action,
      constraint: constraint
        ? {
            countryCode: constraint.countryCode,
            serviceability: constraint.serviceability,
            scaleOverride: constraint.scaleOverride,
            priorityTier: constraint.priorityTier,
            economicsMultiplier: constraint.economicsMultiplier,
            marginModifier: constraint.marginModifier,
          }
        : null,
    },
  });

  return {
    geoKey: `${countryCode}:${action}`,
    countryCode,
    label: input.row.label,
    action,
    queueEligible,
    confidence: clampConfidence(confidence),
    why,
    evidence,
    guardrails: [
      action === "scale" || action === "isolate"
        ? "Scale only while serviceability and margin assumptions stay intact."
        : "Do not build a dedicated manual GEO structure from thin-signal rows.",
    ],
    whatWouldChangeThisDecision: [
      action === "cut"
        ? "ROAS recovering above break-even or serviceability improving would reopen this GEO."
        : "More conversion depth or an explicit business override would change this GEO decision.",
    ],
    clusterKey,
    clusterLabel,
    grouped: false,
    groupMemberCount: 1,
    groupMemberLabels: [input.row.label],
    materiality: {
      thinSignal,
      material,
      archiveContext,
    },
    supportingMetrics: {
      spend: round(input.row.spend),
      revenue: round(input.row.revenue),
      roas: round(roas),
      purchases: input.row.purchases,
      clicks: input.row.clicks,
      impressions: input.row.impressions,
      spendShare:
        input.totalGeoSpend > 0 ? round(input.row.spend / input.totalGeoSpend, 4) : 0,
    },
    freshness: input.geoFreshness,
    commercialContext: {
      serviceability: constraint?.serviceability ?? null,
      priorityTier: constraint?.priorityTier ?? null,
      scaleOverride: constraint?.scaleOverride ?? null,
      economicsMultiplier: constraint?.economicsMultiplier ?? null,
      marginModifier: constraint?.marginModifier ?? null,
      countryEconomicsConfigured:
        input.snapshot.sectionMeta.countryEconomics.configured,
      countryEconomicsUpdatedAt:
        input.snapshot.sectionMeta.countryEconomics.updatedAt,
      countryEconomicsSourceLabel:
        input.snapshot.sectionMeta.countryEconomics.sourceLabel,
    },
    provenance,
    evidenceHash: provenance.evidenceHash,
    actionFingerprint: provenance.actionFingerprint,
    trust,
  };
}

function hydrateGeoClusters(geoDecisions: MetaGeoDecision[]) {
  const decisionsByCluster = new Map<string, MetaGeoDecision[]>();
  for (const decision of geoDecisions) {
    if (!decision.clusterKey) continue;
    const existing = decisionsByCluster.get(decision.clusterKey);
    if (existing) existing.push(decision);
    else decisionsByCluster.set(decision.clusterKey, [decision]);
  }

  return geoDecisions.map((decision) => {
    if (!decision.clusterKey) return decision;
    const peers =
      decisionsByCluster.get(decision.clusterKey)?.slice().sort(
        (left, right) =>
          right.supportingMetrics.spend - left.supportingMetrics.spend ||
          left.label.localeCompare(right.label),
      ) ?? [decision];
    return {
      ...decision,
      grouped: peers.length > 1,
      groupMemberCount: peers.length,
      groupMemberLabels: peers.map((peer) => peer.label),
      clusterLabel: decision.clusterLabel ?? peers[0]?.clusterLabel ?? null,
    };
  });
}

function buildPlacementAnomalies(input: {
  rows: Array<{ key: string; label: string; spend: number; revenue: number }>;
  accountRoas: number;
  provenanceContext: MetaDecisionProvenanceContext;
}) {
  const totalSpend = input.rows.reduce((sum, row) => sum + row.spend, 0);
  return input.rows
    .map((row) => {
      const roas = row.spend > 0 ? row.revenue / row.spend : 0;
      const spendShare = totalSpend > 0 ? row.spend / totalSpend : 0;
      if (row.spend < 150 || spendShare < 0.12) return null;
      if (roas >= input.accountRoas * 0.8) return null;
      const action = "exception_review" as const;
      const evidence: MetaDecisionEvidence[] = [
        { label: "Spend share", value: formatPercent(spendShare * 100), impact: "negative" as const },
        { label: "Placement ROAS", value: formatRatio(roas), impact: "negative" as const },
        { label: "Account ROAS", value: formatRatio(input.accountRoas), impact: "neutral" as const },
      ];
      const sourceDecisionId = `${row.key}:${action}`;
      const provenance = buildMetaDecisionProvenance({
        businessId: input.provenanceContext.businessId,
        decisionAsOf: input.provenanceContext.decisionAsOf,
        analyticsWindow: input.provenanceContext.analyticsWindow,
        reportingRange: input.provenanceContext.reportingRange,
        sourceWindow: input.provenanceContext.sourceWindow,
        sourceRowScope: {
          system: "meta",
          entityType: "placement",
          entityId: row.key,
        },
        sourceDecisionId,
        recommendedAction: action,
        evidence,
        hashEvidence: {
          spend: row.spend,
          revenue: row.revenue,
          spendShare,
          roas,
          accountRoas: input.accountRoas,
          action,
        },
      });
      return {
        placementKey: row.key,
        label: row.label,
        action,
        confidence: clampConfidence(spendShare >= 0.2 ? 0.8 : 0.68),
        note:
          "Advantage+ placements should stay on by default. Review this only because spend concentration is paired with persistent underperformance.",
        evidence,
        whatWouldChangeThisDecision: [
          "If this placement recovers closer to account average or loses spend share concentration, keep automation untouched.",
        ],
        provenance,
        evidenceHash: provenance.evidenceHash,
        actionFingerprint: provenance.actionFingerprint,
      };
    })
    .filter((row): row is NonNullable<typeof row> => Boolean(row));
}

function buildRelatedCreativeNeeds(input: {
  actionType: MetaAdSetActionType;
  strategyClass: MetaStrategyClass;
  ctr: number | null;
  roas: number;
}) {
  const needs: string[] = [];
  if (input.strategyClass === "creative_refresh_required") {
    needs.push("Creative supply looks like the current bottleneck, so refresh hooks before pushing budget or cap changes.");
  }
  if (input.actionType === "rebuild" || input.actionType === "recover") {
    needs.push("Refresh the active creative mix before expecting the same structure to recover.");
  }
  if (input.ctr != null && input.ctr < 1.2) {
    needs.push("CTR is soft, so check whether the message or hook is the real bottleneck.");
  }
  if (input.actionType === "scale_budget" && input.roas >= 3) {
    needs.push("Do not mix new testing creatives into this scaling path unless a separate validation lane exists.");
  }
  return needs;
}

function buildAdSetDecision(input: {
  adSet: MetaAdSetData;
  campaign: MetaCampaignRow | null;
  campaignRole: MetaCampaignRole;
  thresholds: TargetThresholds;
  commercialTruth: BusinessCommercialTruthSnapshot;
  geoCoverageMode: MetaCommercialFallbackMode;
  operatingMode: AccountOperatingModePayload | null;
  decisionAsOf: string;
  provenanceContext: MetaDecisionProvenanceContext;
}): MetaAdSetDecision {
  const roas = input.adSet.spend > 0 ? input.adSet.revenue / input.adSet.spend : 0;
  const cpa = input.adSet.cpa ?? (input.adSet.purchases > 0 ? input.adSet.spend / input.adSet.purchases : null);
  const ctr = input.adSet.inlineLinkClickCtr ?? input.adSet.ctr ?? null;
  const hasStrongSignal = input.adSet.spend >= 250 && input.adSet.purchases >= 8;
  const hasHighSignal = input.adSet.spend >= 500 && input.adSet.purchases >= 12;
  const hasVeryStrongSignal = input.adSet.spend >= 500 && input.adSet.purchases >= 18;
  const lowSignal = !hasStrongSignal;
  const recentChange =
    isRecentIso(input.adSet.previousBudgetCapturedAt, input.decisionAsOf, 3) ||
    isRecentIso(input.adSet.previousBidValueCapturedAt, input.decisionAsOf, 3);
  const mixedConfig =
    input.adSet.isConfigMixed ||
    input.adSet.isBudgetMixed ||
    Boolean(input.adSet.isOptimizationGoalMixed) ||
    Boolean(input.adSet.isBidStrategyMixed) ||
    Boolean(input.adSet.isBidValueMixed);
  const targetMet =
    roas >= input.thresholds.targetRoas ||
    (cpa != null && cpa <= input.thresholds.targetCpa);
  const breakEvenMiss =
    (roas > 0 && roas < input.thresholds.breakEvenRoas) ||
    (cpa != null && cpa > input.thresholds.breakEvenCpa);
  const clearBreakEvenLoss =
    (roas > 0 && roas < input.thresholds.breakEvenRoas * 0.8) ||
    (cpa != null && cpa > input.thresholds.breakEvenCpa * 1.15);
  const nearTarget =
    (roas > 0 && roas >= input.thresholds.targetRoas * 0.9 && roas < input.thresholds.targetRoas) ||
    (cpa != null && cpa <= input.thresholds.targetCpa * 1.1 && cpa > input.thresholds.targetCpa);
  const manualDoNotScale = Boolean(input.commercialTruth.operatingConstraints?.manualDoNotScaleReason);
  const stockBlocked = input.commercialTruth.operatingConstraints?.stockPressureStatus === "blocked";
  const landingConcern = Boolean(input.commercialTruth.operatingConstraints?.landingPageConcern);
  const retargetingRole =
    input.campaignRole === "Retargeting" || input.campaignRole === "Existing Customer / LTV";
  const geoRole = input.campaignRole === "Geo Expansion";
  const objectiveFamily = classifyObjectiveFamily({
    campaign: input.campaign,
    adSet: input.adSet,
    campaignRole: input.campaignRole,
  });
  const bidRegime = classifyBidRegime({
    campaign: input.campaign,
    adSet: input.adSet,
  });
  const constrainedBidRegime =
    bidRegime === "cost_cap" || bidRegime === "bid_cap" || bidRegime === "roas_floor";
  const activeStatus = normalizeText(input.adSet.status) === "active";
  const lowerFunnelObjective =
    objectiveFamily === "sales" ||
    objectiveFamily === "catalog" ||
    objectiveFamily === "leads" ||
    retargetingRole;
  const promoSafeWinner =
    normalizeText(input.campaign?.name).includes("promo") &&
    targetMet &&
    hasStrongSignal &&
    !recentChange &&
    !mixedConfig;
  const creativeFatigueCandidate =
    activeStatus &&
    !recentChange &&
    !mixedConfig &&
    !manualDoNotScale &&
    !stockBlocked &&
    !lowSignal &&
    ctr != null &&
    ctr < 1.05 &&
    roas >= input.thresholds.breakEvenRoas &&
    roas < input.thresholds.targetRoas;
  const trulyStableWinner =
    activeStatus &&
    targetMet &&
    hasVeryStrongSignal &&
    !recentChange &&
    !mixedConfig &&
    !manualDoNotScale &&
    !stockBlocked &&
    !landingConcern;
  const scaleCandidate =
    trulyStableWinner &&
    !retargetingRole &&
    !promoSafeWinner &&
    !creativeFatigueCandidate &&
    objectiveFamily !== "awareness" &&
    objectiveFamily !== "traffic" &&
    (!constrainedBidRegime ||
      roas >= input.thresholds.targetRoas * 1.15 ||
      (cpa != null && cpa <= input.thresholds.targetCpa * 0.9));
  const stableProtectedWinner = trulyStableWinner && !scaleCandidate;
  const clearPauseLoss =
    activeStatus &&
    lowerFunnelObjective &&
    hasHighSignal &&
    clearBreakEvenLoss &&
    !recentChange &&
    !mixedConfig &&
    !manualDoNotScale &&
    !stockBlocked &&
    !landingConcern &&
    input.geoCoverageMode !== "conservative_fallback";
  const bidRegimePressure =
    constrainedBidRegime &&
    activeStatus &&
    hasStrongSignal &&
    !recentChange &&
    !mixedConfig &&
    !targetMet &&
    !breakEvenMiss;
  const objectiveUpgradeReady =
    normalizeText(input.adSet.optimizationGoal).includes("add to cart") &&
    hasStrongSignal &&
    roas >= input.thresholds.targetRoas;
  const narrowReachWinner =
    targetMet &&
    input.adSet.impressions < 20_000 &&
    input.adSet.clicks < 250 &&
    !recentChange &&
    !mixedConfig;
  const actionReasons: string[] = [];
  const guardrails: string[] = [];
  const secondaryDriverPool: MetaPolicyDriver[] = [];
  if (lowSignal) secondaryDriverPool.push("thin_signal");
  if (hasStrongSignal) secondaryDriverPool.push("signal_density");
  if (recentChange) secondaryDriverPool.push("recent_change_cooldown");
  if (mixedConfig) secondaryDriverPool.push("mixed_config");
  if (manualDoNotScale || stockBlocked || landingConcern) {
    secondaryDriverPool.push("constraint_pressure");
  }
  if (constrainedBidRegime) secondaryDriverPool.push("bid_regime_pressure");

  let strategyClass: MetaStrategyClass = "monitor_only";
  let actionSize: MetaActionSize = "none";
  let confidence = 0.74;
  let primaryDriver: MetaPolicyDriver = lowSignal ? "thin_signal" : "signal_density";
  let winnerState: MetaWinnerState = "not_a_winner";
  let fallbackDisposition: DecisionOperatorDisposition | null = null;

  if (stockBlocked || manualDoNotScale) {
    strategyClass = "review_hold";
    confidence = 0.9;
    primaryDriver = "constraint_pressure";
    winnerState = "guarded";
    actionReasons.push(
      stockBlocked
        ? "Operating constraints say stock pressure is blocked."
        : "Commercial constraints include an explicit do-not-scale instruction.",
    );
    guardrails.push("Do not widen spend until the operator-level constraint is cleared.");
  } else if (clearPauseLoss) {
    strategyClass = "pause";
    actionSize = "large";
    confidence = 0.91;
    primaryDriver = "break_even_loss";
    winnerState = "guarded";
    actionReasons.push("Efficiency is clearly below break-even with enough clean signal to justify a hard stop.");
    guardrails.push("Pause the loser before scaling any adjacent lanes.");
  } else if (mixedConfig && hasStrongSignal) {
    strategyClass = "rebuild";
    actionSize = "medium";
    confidence = 0.86;
    primaryDriver = "mixed_config";
    winnerState = "guarded";
    actionReasons.push("Mixed budget or optimization config makes this ad set hard to trust operationally.");
    guardrails.push("Rebuild into a cleaner structure instead of stacking more edits onto mixed config.");
  } else if (retargetingRole && targetMet && !activeStatus && !recentChange && !mixedConfig) {
    strategyClass = "recover";
    actionSize = "medium";
    confidence = 0.84;
    primaryDriver = "signal_density";
    winnerState = "recovering";
    actionReasons.push("This retargeting lane is efficient enough to recover even though delivery is muted.");
    guardrails.push("Recover in controlled steps and keep audience intent clean.");
  } else if (creativeFatigueCandidate) {
    strategyClass = "creative_refresh_required";
    confidence = 0.78;
    primaryDriver = "creative_fatigue";
    winnerState = "creative_refresh_required";
    actionReasons.push("Signal is established, but soft click-through quality says the current creative is the bottleneck.");
    guardrails.push("Refresh creative supply before changing budget, bid, and structure together.");
  } else if (scaleCandidate) {
    strategyClass = "scale_budget";
    actionSize = roas >= input.thresholds.targetRoas * 1.2 ? "large" : "medium";
    confidence = input.geoCoverageMode === "configured_targets" ? 0.88 : 0.78;
    primaryDriver =
      roas >= input.thresholds.targetRoas ? "roas_outperforming" : "cpa_efficiency";
    winnerState = "scale_candidate";
    actionReasons.push("This ad set is beating target with strong clean signal and still has room for controlled scale.");
    guardrails.push("Scale in steps rather than by a single large jump.");
  } else if (stableProtectedWinner) {
    strategyClass = "stable_no_touch";
    confidence = retargetingRole || promoSafeWinner ? 0.86 : 0.83;
    primaryDriver = "winner_stability";
    winnerState = "stable_no_touch";
    actionReasons.push(
      retargetingRole || promoSafeWinner
        ? "This is a stable active winner, so the cleaner move today is to protect it instead of adding more change."
        : "This winner is active and stable, but the current signal does not justify a broader push today.",
    );
    guardrails.push("Keep this winner stable and avoid mixing testing changes into it.");
  } else if (recentChange || landingConcern) {
    strategyClass = "review_hold";
    confidence = recentChange ? 0.72 : 0.7;
    primaryDriver = recentChange
      ? "recent_change_cooldown"
      : "constraint_pressure";
    winnerState = targetMet ? "guarded" : "not_a_winner";
    actionReasons.push(
      recentChange
        ? "A recent config change is still settling."
        : "Landing-page concern lowers confidence in any aggressive move.",
    );
    guardrails.push("Hold until the current signal resolves more clearly.");
  } else if (breakEvenMiss && hasStrongSignal) {
    strategyClass = "reduce_budget";
    actionSize = "medium";
    confidence = 0.8;
    primaryDriver = "break_even_loss";
    winnerState = "guarded";
    actionReasons.push("Performance is below break-even enough to cut load, but not clean enough for a hard pause.");
    guardrails.push("Reduce load before testing broader fixes.");
  } else if (geoRole && targetMet && lowSignal) {
    strategyClass = "duplicate_to_new_geo_cluster";
    actionSize = "small";
    confidence = 0.7;
    primaryDriver = "geo_validation";
    winnerState = "guarded";
    actionReasons.push("Geo expansion is promising, but the next move should stay controlled through a new cluster.");
    guardrails.push("Keep this as a validation move, not a broad budget release.");
  } else if (geoRole && breakEvenMiss && lowSignal) {
    strategyClass = "merge_into_pooled_geo";
    actionSize = "small";
    confidence = 0.68;
    primaryDriver = "geo_validation";
    winnerState = "guarded";
    actionReasons.push("Thin-signal geo expansion should be pooled instead of isolated.");
    guardrails.push("Do not keep a dedicated geo path alive without enough signal.");
  } else if (objectiveUpgradeReady) {
    strategyClass = "switch_optimization";
    actionSize = "small";
    confidence = 0.74;
    primaryDriver = "objective_upgrade";
    winnerState = "guarded";
    actionReasons.push("The lane is healthy enough that a cleaner purchase optimization path is justified.");
    guardrails.push("Only switch optimization once the current stable baseline is documented.");
  } else if (bidRegimePressure) {
    strategyClass = "review_cost_cap";
    actionSize = "small";
    confidence = 0.69;
    primaryDriver = "bid_regime_pressure";
    winnerState = "guarded";
    actionReasons.push("Bid control is the main lever here, so review the cap before making broader structural changes.");
    guardrails.push("Change the bid guardrail before changing multiple levers at once.");
  } else if (nearTarget) {
    strategyClass = "review_hold";
    confidence = 0.7;
    primaryDriver = "signal_density";
    winnerState = targetMet ? "guarded" : "not_a_winner";
    actionReasons.push("Signal is near target but not strong enough for a decisive move.");
    guardrails.push("Hold until the current signal resolves more clearly.");
  } else if (
    (objectiveFamily === "awareness" || objectiveFamily === "traffic") &&
    narrowReachWinner
  ) {
    strategyClass = "broaden";
    actionSize = "small";
    confidence = 0.64;
    primaryDriver = "signal_density";
    winnerState = "guarded";
    actionReasons.push("Efficiency is strong, but reach is still narrow enough to justify a controlled broadening move.");
    guardrails.push("Broaden only after checking that current winners are not simply budget-limited.");
  } else if (lowSignal) {
    strategyClass = "monitor_only";
    confidence = 0.58;
    primaryDriver = "thin_signal";
    actionReasons.push("This ad set does not have enough clean signal for a bigger action.");
    guardrails.push("Low-signal lanes should stay observable, not over-operated.");
  } else if (narrowReachWinner) {
    strategyClass = "broaden";
    actionSize = "small";
    confidence = 0.66;
    primaryDriver = "signal_density";
    winnerState = "guarded";
    actionReasons.push("Efficiency is strong, but reach is still narrow enough that a controlled broadening move is cleaner than a budget jump.");
    guardrails.push("Broaden only after checking that the current winning path is not just budget-limited.");
  } else {
    strategyClass = "review_hold";
    confidence = 0.63;
    primaryDriver = "signal_density";
    actionReasons.push("Signal is real, but the next move still needs operator review before changing spend or structure.");
    guardrails.push("Hold this lane until the next clean efficiency or constraint signal appears.");
  }

  if (input.geoCoverageMode === "conservative_fallback") {
    if (strategyClass === "pause") {
      strategyClass = hasStrongSignal ? "reduce_budget" : "review_hold";
      actionSize = hasStrongSignal ? "medium" : "none";
      confidence = Math.min(confidence, hasStrongSignal ? 0.72 : 0.66);
      fallbackDisposition = hasStrongSignal ? "review_reduce" : "review_hold";
      winnerState = "degraded";
      secondaryDriverPool.push("break_even_loss");
      primaryDriver = "degraded_truth_cap";
      actionReasons.unshift(
        "Commercial targets are missing, so a hard pause is downgraded to a review-safe action.",
      );
    } else if (
      strategyClass === "scale_budget" ||
      strategyClass === "broaden" ||
      strategyClass === "review_cost_cap" ||
      strategyClass === "recover"
    ) {
      strategyClass = "review_hold";
      actionSize = "none";
      confidence = Math.min(confidence, 0.68);
      fallbackDisposition = "profitable_truth_capped";
      winnerState = "degraded";
      secondaryDriverPool.push(primaryDriver);
      primaryDriver = "degraded_truth_cap";
      actionReasons.unshift("Commercial targets are missing, so aggressive actions are downgraded to a safer hold.");
    } else if (strategyClass === "reduce_budget") {
      fallbackDisposition = "review_reduce";
      secondaryDriverPool.push("degraded_truth_cap");
    } else if (
      strategyClass === "review_hold" ||
      strategyClass === "creative_refresh_required" ||
      strategyClass === "stable_no_touch"
    ) {
      fallbackDisposition = "review_hold";
      if (winnerState !== "not_a_winner") winnerState = "degraded";
      secondaryDriverPool.push("degraded_truth_cap");
    } else if (strategyClass === "monitor_only") {
      fallbackDisposition = "monitor_low_truth";
      secondaryDriverPool.push("degraded_truth_cap");
    }
  }
  if (mixedConfig) confidence -= 0.08;
  if (recentChange) confidence -= 0.07;
  if (lowSignal) confidence -= 0.09;
  if (input.geoCoverageMode === "conservative_fallback") confidence -= 0.05;

  const policyLadder = buildMetaPolicyLadder({
    baselineStrategyClass: strategyClass,
    baselineActionSize: actionSize,
    baselinePrimaryDriver: primaryDriver,
    baselineWinnerState: winnerState,
    baselineReason:
      actionReasons[0] ??
      "Meta policy ladder is waiting for a cleaner signal before changing spend or structure.",
    objectiveFamily,
    bidRegime,
    campaignRole: input.campaignRole,
    fallbackDisposition,
    operatingMode: input.operatingMode,
    targetMet,
    lowSignal,
    recentChange,
    mixedConfig,
    geoRole,
    stableProtectedWinner,
    creativeFatigueCandidate,
    constrainedBidRegime,
    bidRegimePressure,
  });

  if (
    policyLadder.strategyClass !== strategyClass &&
    actionReasons[0] !== policyLadder.selectedReason
  ) {
    actionReasons.unshift(policyLadder.selectedReason);
  }
  if (
    policyLadder.selectedGuardrail &&
    !guardrails.includes(policyLadder.selectedGuardrail)
  ) {
    guardrails.push(policyLadder.selectedGuardrail);
  }
  if (!secondaryDriverPool.includes(policyLadder.primaryDriver)) {
    secondaryDriverPool.push(policyLadder.primaryDriver);
  }
  strategyClass = policyLadder.strategyClass;
  actionSize = policyLadder.actionSize;
  primaryDriver = policyLadder.primaryDriver;
  winnerState = policyLadder.winnerState;

  const actionType = mapStrategyClassToActionType(strategyClass);
  const noTouch =
    strategyClass === "stable_no_touch" &&
    activeStatus &&
    targetMet &&
    hasVeryStrongSignal &&
    !recentChange &&
    !mixedConfig &&
    !manualDoNotScale &&
    !stockBlocked &&
    !landingConcern &&
    input.geoCoverageMode !== "conservative_fallback";

  if (noTouch && !actionReasons[0]?.includes("stable active winner")) {
    actionReasons.unshift("This is a stable winner, so the safer move is to preserve it.");
    guardrails.push("Do not mix tests or structure changes into this winner path.");
  }

  const entityState = classifyDecisionEntityState({
    status: input.adSet.status,
    spend: input.adSet.spend,
  });
  const materiality = classifyDecisionMateriality({
    spend: input.adSet.spend,
    purchases: input.adSet.purchases,
    impressions: input.adSet.impressions,
    archiveSpendThreshold: 60,
    archiveImpressionThreshold: 3_000,
    thinSignalSpendThreshold: 120,
    thinSignalPurchaseThreshold: 3,
  });
  const archiveContext =
    entityState !== "active" || materiality === "immaterial";
  const watchlistAction =
    noTouch ||
    strategyClass === "review_hold" ||
    strategyClass === "creative_refresh_required" ||
    actionType === "hold" ||
    actionType === "monitor_only";
  const trust = archiveContext
    ? compileDecisionTrust({
        surfaceLane: "archive_context",
        truthState: "inactive_or_immaterial",
        operatorDisposition: "archive_only",
        entityState,
        materiality,
        reasons: [
          isInactiveMetaStatus(input.adSet.status)
            ? `Ad set status is ${normalizeText(input.adSet.status)}.`
            : "Ad set volume is too small for the live action core.",
          actionReasons[0],
        ],
      })
    : fallbackDisposition
      ? compileDecisionTrust({
          surfaceLane:
            fallbackDisposition === "review_reduce" ? "action_core" : "watchlist",
          truthState: "degraded_missing_truth",
          operatorDisposition: fallbackDisposition,
          entityState,
          materiality,
          freshness: input.operatingMode?.authority?.freshness,
          missingInputs: input.operatingMode?.missingInputs ?? [],
          reasons: [
            "Commercial truth is incomplete, so this action is trust-capped.",
            actionReasons[0],
          ],
        })
      : noTouch
        ? compileDecisionTrust({
            surfaceLane: "watchlist",
            truthState: "live_confident",
            operatorDisposition: "protected_watchlist",
            entityState,
            materiality,
            freshness: input.operatingMode?.authority?.freshness,
            reasons: [actionReasons[0]],
          })
        : watchlistAction
          ? compileDecisionTrust({
              surfaceLane: "watchlist",
              truthState: "live_confident",
              operatorDisposition: actionType === "monitor_only" ? "monitor_low_truth" : "review_hold",
              entityState,
              materiality,
              freshness: input.operatingMode?.authority?.freshness,
              reasons: [actionReasons[0]],
            })
        : compileDecisionTrust({
            surfaceLane: "action_core",
            truthState: "live_confident",
            operatorDisposition: "standard",
            entityState,
            materiality,
            freshness: input.operatingMode?.authority?.freshness,
            reasons: [actionReasons[0]],
          });
  const policy: MetaDecisionPolicy = {
    strategyClass,
    objectiveFamily,
    bidRegime,
    primaryDriver,
    secondaryDrivers: uniqueValues(
      secondaryDriverPool.filter((driver) => driver !== primaryDriver),
    ),
    winnerState:
      fallbackDisposition && winnerState !== "not_a_winner" ? "degraded" : winnerState,
    explanation: policyLadder.explanation,
  };
  const priority = determinePriorityFromAction(actionType, strategyClass, confidence);
  const decisionId = `${input.adSet.id}:${actionType}`;
  const evidence: MetaDecisionEvidence[] = [
    {
      label: "ROAS",
      value: formatRatio(roas),
      impact:
        roas >= input.thresholds.targetRoas
          ? "positive"
          : roas < input.thresholds.breakEvenRoas
            ? "negative"
            : "mixed",
    },
    {
      label: "CPA",
      value: formatCurrency(cpa),
      impact:
        cpa != null && cpa <= input.thresholds.targetCpa
          ? "positive"
          : cpa != null && cpa > input.thresholds.breakEvenCpa
            ? "negative"
            : "neutral",
    },
    {
      label: "Signal depth",
      value: `${input.adSet.spend.toLocaleString("en-US")} spend / ${input.adSet.purchases.toLocaleString("en-US")} purchases`,
      impact: hasStrongSignal ? "positive" : "neutral",
    },
  ];
  const provenance = buildMetaDecisionProvenance({
    businessId: input.provenanceContext.businessId,
    decisionAsOf: input.provenanceContext.decisionAsOf,
    analyticsWindow: input.provenanceContext.analyticsWindow,
    reportingRange: input.provenanceContext.reportingRange,
    sourceWindow: input.provenanceContext.sourceWindow,
    sourceRowScope: {
      system: "meta",
      entityType: "adset",
      entityId: input.adSet.id,
    },
    sourceDecisionId: decisionId,
    recommendedAction: actionType,
    evidence,
    hashEvidence: {
      spend: input.adSet.spend,
      revenue: input.adSet.revenue,
      roas,
      cpa,
      purchases: input.adSet.purchases,
      impressions: input.adSet.impressions,
      clicks: input.adSet.clicks,
      targetRoas: input.thresholds.targetRoas,
      breakEvenRoas: input.thresholds.breakEvenRoas,
      targetCpa: input.thresholds.targetCpa,
      breakEvenCpa: input.thresholds.breakEvenCpa,
      actionType,
      actionSize,
      confidence: clampConfidence(confidence),
      bidStrategyLabel: input.adSet.bidStrategyLabel,
      optimizationGoal: input.adSet.optimizationGoal,
    },
  });
  const operatorPolicy = assessMetaOperatorPolicy({
    entityType: "adset",
    action: actionType,
    trust,
    authority: input.operatingMode?.authority ?? null,
    provenance,
    evidenceSource: input.provenanceContext.evidenceSource,
    noTouch,
    commercialTruthMode: input.geoCoverageMode,
    commercialMissingInputs: input.operatingMode?.missingInputs ?? [],
    budgetOwner: input.adSet.budgetLevel ?? "unknown",
    budgetConstraint: inferMetaBudgetConstraint({
      spend: input.adSet.spend,
      dailyBudget: input.adSet.dailyBudget,
      lifetimeBudget: input.adSet.lifetimeBudget,
      windowDays: inclusiveWindowDays(
        input.provenanceContext.sourceWindow.startDate,
        input.provenanceContext.sourceWindow.endDate,
      ),
    }),
    supportingMetrics: {
      spend: input.adSet.spend,
      purchases: input.adSet.purchases,
      impressions: input.adSet.impressions,
      dailyBudget: input.adSet.dailyBudget,
      lifetimeBudget: input.adSet.lifetimeBudget,
      bidStrategyLabel: input.adSet.bidStrategyLabel,
      optimizationGoal: input.adSet.optimizationGoal,
    },
  });

  return {
    decisionId,
    adSetId: input.adSet.id,
    adSetName: input.adSet.name,
    campaignId: input.adSet.campaignId,
    campaignName: input.campaign?.name ?? "Unknown campaign",
    actionType,
    actionSize,
    priority,
    confidence: clampConfidence(confidence),
    reasons: actionReasons,
    guardrails,
    relatedCreativeNeeds: buildRelatedCreativeNeeds({
      actionType,
      strategyClass,
      ctr,
      roas,
    }),
    relatedGeoContext:
      input.campaignRole === "Geo Expansion"
        ? ["Keep GEO actions operational. Thin-signal lanes should pool or validate before isolated scale."]
        : [],
    supportingMetrics: {
      spend: round(input.adSet.spend),
      revenue: round(input.adSet.revenue),
      roas: round(roas),
      cpa: cpa != null ? round(cpa) : null,
      ctr,
      purchases: input.adSet.purchases,
      impressions: input.adSet.impressions,
      clicks: input.adSet.clicks,
      bidStrategyLabel: input.adSet.bidStrategyLabel ?? null,
      optimizationGoal: input.adSet.optimizationGoal ?? null,
      dailyBudget: input.adSet.dailyBudget ?? null,
      lifetimeBudget: input.adSet.lifetimeBudget ?? null,
      budgetLevel: input.adSet.budgetLevel ?? null,
    },
    whatWouldChangeThisDecision: [
      noTouch
        ? "A clear efficiency drop, promo change, or new operator constraint would reopen this winner."
        : "A stronger target hit, cleaner config, or more conversion depth would change this action.",
    ],
    noTouch,
    policy,
    operatorPolicy,
    provenance,
    evidenceHash: provenance.evidenceHash,
    actionFingerprint: provenance.actionFingerprint,
    trust,
  };
}

function buildCampaignDecision(input: {
  campaign: MetaCampaignRow;
  laneLabel: "Scaling" | "Validation" | "Test" | null;
  roleDecision: CampaignRoleDecision;
  adSetDecisions: MetaAdSetDecision[];
  thresholds: TargetThresholds;
  operatingMode: AccountOperatingModePayload | null;
  provenanceContext: MetaDecisionProvenanceContext;
}): MetaCampaignDecision {
  const topAdSetDecision =
    [...input.adSetDecisions].sort(
      (left, right) =>
        ACTION_PRIORITY[left.actionType] - ACTION_PRIORITY[right.actionType] ||
        right.confidence - left.confidence,
    )[0] ?? null;
  const noTouch = input.adSetDecisions.some((decision) => decision.noTouch);
  const roas = input.campaign.spend > 0 ? input.campaign.revenue / input.campaign.spend : 0;
  const objectiveFamily = classifyObjectiveFamily({
    campaign: input.campaign,
    adSet: null,
    campaignRole: input.roleDecision.role,
  });
  const dominantPolicy = topAdSetDecision?.policy ?? {
    strategyClass: noTouch ? "stable_no_touch" : "review_hold",
    objectiveFamily,
    bidRegime: "unknown" as const,
    primaryDriver: noTouch ? "winner_stability" : "signal_density",
    secondaryDrivers: [],
    winnerState: noTouch ? "stable_no_touch" : "not_a_winner",
    explanation: undefined,
  };
  const primaryAction = noTouch
    ? "hold"
    : topAdSetDecision?.actionType ??
      (roas >= input.thresholds.targetRoas ? "scale_budget" : "monitor_only");
  const evidence: MetaDecisionEvidence[] = [
    {
      label: "ROAS",
      value: formatRatio(roas),
      impact:
        roas >= input.thresholds.targetRoas
          ? "positive"
          : roas < input.thresholds.breakEvenRoas
            ? "negative"
            : "mixed",
    },
    {
      label: "Spend",
      value: formatCurrency(input.campaign.spend),
      impact: "neutral",
    },
    {
      label: "Role confidence",
      value: formatPercent(input.roleDecision.confidence * 100),
      impact: "neutral",
    },
  ];
  const why = noTouch
    ? "This campaign contains a stable winner that should be protected before making broader changes."
    : topAdSetDecision?.reasons[0] ?? input.roleDecision.why;
  const decisionId = `${input.campaign.id}:${primaryAction}`;
  const degradedFromAdSets = input.adSetDecisions.some(
    (decision) => decision.trust.truthState === "degraded_missing_truth",
  );
  const profitableTruthCappedFromAdSets = input.adSetDecisions.some(
    (decision) => decision.trust.operatorDisposition === "profitable_truth_capped",
  );
  const archiveContext =
    isArchiveMetaCampaign(input.campaign) ||
    input.adSetDecisions.every(
      (decision) => decision.trust.surfaceLane === "archive_context",
    );
  const watchlistAction =
    noTouch ||
    primaryAction === "hold" ||
    primaryAction === "monitor_only" ||
    input.adSetDecisions.some((decision) => decision.trust.surfaceLane === "watchlist");
  const entityState = classifyDecisionEntityState({
    status: input.campaign.status,
    spend: input.campaign.spend,
  });
  const materiality = classifyDecisionMateriality({
    spend: input.campaign.spend,
    purchases: input.campaign.purchases,
    impressions: input.campaign.impressions,
    archiveSpendThreshold: 90,
    archiveImpressionThreshold: 8_000,
    thinSignalSpendThreshold: 180,
    thinSignalPurchaseThreshold: 4,
  });
  const trust = archiveContext
    ? compileDecisionTrust({
        surfaceLane: "archive_context",
        truthState: "inactive_or_immaterial",
        operatorDisposition: "archive_only",
        entityState,
        materiality,
        reasons: [
          isInactiveMetaStatus(input.campaign.status)
            ? `Campaign status is ${normalizeText(input.campaign.status)}.`
            : "Campaign signal is inactive or immaterial for the default action core.",
          why,
        ],
      })
    : degradedFromAdSets
      ? compileDecisionTrust({
          surfaceLane: watchlistAction ? "watchlist" : "action_core",
          truthState: "degraded_missing_truth",
          operatorDisposition:
            primaryAction === "reduce_budget"
              ? "review_reduce"
              : profitableTruthCappedFromAdSets
                ? "profitable_truth_capped"
                : "review_hold",
          entityState,
          materiality,
          freshness: input.operatingMode?.authority?.freshness,
          missingInputs: input.operatingMode?.missingInputs ?? [],
          reasons: [
            "Related ad-set actions are trust-capped because commercial truth is incomplete.",
            why,
          ],
        })
      : noTouch
        ? compileDecisionTrust({
            surfaceLane: "watchlist",
            truthState: "live_confident",
            operatorDisposition: "protected_watchlist",
            entityState,
            materiality,
            freshness: input.operatingMode?.authority?.freshness,
            reasons: [why],
          })
      : watchlistAction
        ? compileDecisionTrust({
            surfaceLane: "watchlist",
            truthState: "live_confident",
            operatorDisposition: "review_hold",
              entityState,
              materiality,
              freshness: input.operatingMode?.authority?.freshness,
              reasons: [why],
            })
          : compileDecisionTrust({
              surfaceLane: "action_core",
              truthState: "live_confident",
              operatorDisposition: "standard",
              entityState,
              materiality,
              freshness: input.operatingMode?.authority?.freshness,
              reasons: [why],
            });
  const provenance = buildMetaDecisionProvenance({
    businessId: input.provenanceContext.businessId,
    decisionAsOf: input.provenanceContext.decisionAsOf,
    analyticsWindow: input.provenanceContext.analyticsWindow,
    reportingRange: input.provenanceContext.reportingRange,
    sourceWindow: input.provenanceContext.sourceWindow,
    sourceRowScope: {
      system: "meta",
      entityType: "campaign",
      entityId: input.campaign.id,
    },
    sourceDecisionId: decisionId,
    recommendedAction: primaryAction,
    evidence,
    hashEvidence: {
      spend: input.campaign.spend,
      revenue: input.campaign.revenue,
      roas,
      purchases: input.campaign.purchases,
      impressions: input.campaign.impressions,
      role: input.roleDecision.role,
      roleConfidence: input.roleDecision.confidence,
      primaryAction,
      topAdSetDecisionId: topAdSetDecision?.decisionId ?? null,
      adSetDecisionIds: input.adSetDecisions.map((decision) => decision.decisionId),
    },
  });
  const operatorPolicy = assessMetaOperatorPolicy({
    entityType: "campaign",
    action: primaryAction,
    trust,
    authority: input.operatingMode?.authority ?? null,
    provenance,
    evidenceSource: input.provenanceContext.evidenceSource,
    noTouch,
    commercialTruthMode: input.thresholds.mode,
    commercialMissingInputs: input.operatingMode?.missingInputs ?? [],
    budgetOwner: "campaign",
    budgetConstraint:
      topAdSetDecision?.operatorPolicy?.blockers.some((reason) =>
        reason.toLowerCase().includes("budget is not the binding constraint"),
      )
        ? "not_binding"
        : "unknown",
    supportingMetrics: {
      spend: input.campaign.spend,
      purchases: input.campaign.purchases,
      impressions: input.campaign.impressions,
      dailyBudget: input.campaign.dailyBudget ?? null,
      lifetimeBudget: input.campaign.lifetimeBudget ?? null,
    },
  });

  return {
    campaignId: input.campaign.id,
    campaignName: input.campaign.name,
    status: input.campaign.status,
    role: input.roleDecision.role,
    primaryAction,
    confidence: clampConfidence(
      topAdSetDecision
        ? (topAdSetDecision.confidence + input.roleDecision.confidence) / 2
        : input.roleDecision.confidence,
    ),
    why,
    evidence,
    guardrails: noTouch
      ? ["Preserve the winner path and avoid mixing in structural testing."]
      : [
          primaryAction === "scale_budget"
            ? "Scale only while the supporting ad-set winners remain stable."
            : "Use the ad-set action list to decide where this campaign should move next.",
        ],
    noTouch,
    whatWouldChangeThisDecision: [
      noTouch
        ? "Only a clear efficiency drop or a new business constraint should change this protection call."
        : "A different ad-set winner/loser mix would change this campaign-level action.",
    ],
    adSetDecisionIds: input.adSetDecisions.map((decision) => decision.decisionId),
    laneLabel: input.laneLabel,
    policy: {
      ...dominantPolicy,
      objectiveFamily,
      primaryDriver:
        noTouch && dominantPolicy.primaryDriver !== "winner_stability"
          ? "winner_stability"
          : dominantPolicy.primaryDriver,
      winnerState:
        noTouch && dominantPolicy.winnerState !== "stable_no_touch"
          ? "stable_no_touch"
          : dominantPolicy.winnerState,
      explanation: dominantPolicy.explanation
        ? {
            ...dominantPolicy.explanation,
            summary: noTouch
              ? "Campaign-level cutover keeps the protected winner path active."
              : dominantPolicy.explanation.summary,
          }
        : undefined,
    },
    trust,
    operatorPolicy,
    provenance,
    evidenceHash: provenance.evidenceHash,
    actionFingerprint: provenance.actionFingerprint,
    creativeCandidates: null,
    missingCreativeAsk: [],
  };
}

function buildWinnerScaleCandidates(input: {
  adSetDecisions: MetaAdSetDecision[];
}) {
  return input.adSetDecisions
    .filter(
      (decision) =>
        decision.actionType === "scale_budget" &&
        decision.trust.surfaceLane === "action_core" &&
        decision.trust.truthState === "live_confident" &&
        decision.policy.winnerState === "scale_candidate" &&
        !decision.noTouch,
    )
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        right.supportingMetrics.roas - left.supportingMetrics.roas,
    )
    .slice(0, 8)
    .map((decision) => ({
      candidateId: `${decision.campaignId}:${decision.adSetId}`,
      campaignId: decision.campaignId,
      campaignName: decision.campaignName,
      adSetId: decision.adSetId,
      adSetName: decision.adSetName,
      confidence: decision.confidence,
      why:
        decision.reasons[0] ??
        "This ad set is beating target cleanly enough to stay on the winner scale board.",
      suggestedMoveBand: buildSuggestedMoveBand(decision.actionSize),
      evidence: [
        {
          label: "ROAS",
          value: formatRatio(decision.supportingMetrics.roas),
          impact: "positive" as const,
        },
        {
          label: "Spend",
          value: formatCurrency(decision.supportingMetrics.spend),
          impact: "neutral" as const,
        },
        {
          label: "Purchases",
          value: String(decision.supportingMetrics.purchases),
          impact: "positive" as const,
        },
      ],
      guardrails: decision.guardrails,
      supportingMetrics: {
        spend: decision.supportingMetrics.spend,
        revenue: decision.supportingMetrics.revenue,
        roas: decision.supportingMetrics.roas,
        cpa: decision.supportingMetrics.cpa,
        ctr: decision.supportingMetrics.ctr,
        purchases: decision.supportingMetrics.purchases,
        dailyBudget: decision.supportingMetrics.dailyBudget,
        bidStrategyLabel: decision.supportingMetrics.bidStrategyLabel,
        optimizationGoal: decision.supportingMetrics.optimizationGoal,
      },
      policy: decision.policy,
    }));
}

function buildMetaOpportunityTrust(input: {
  baseTrust: DecisionTrustMetadata;
  reasons: string[];
}) {
  return compileDecisionTrust({
    surfaceLane: "opportunity_board",
    truthState: input.baseTrust.truthState,
    operatorDisposition: input.baseTrust.operatorDisposition,
    entityState: input.baseTrust.evidence?.entityState,
    materiality: input.baseTrust.evidence?.materiality,
    freshness: input.baseTrust.evidence?.freshness,
    reasons: input.reasons,
    missingInputs:
      input.baseTrust.truthState === "degraded_missing_truth"
        ? input.baseTrust.reasons
        : [],
    suppressionReasons: input.reasons,
  });
}

function buildMetaGeoOpportunityFloors(input: {
  decision: MetaGeoDecision;
}) {
  const signalFloor = buildDecisionEvidenceFloor({
    key: "signal_depth",
    label: "Signal depth",
    current: `${formatCurrency(input.decision.supportingMetrics.spend)} / ${input.decision.supportingMetrics.purchases} purchases`,
    required: "$250 spend and 6 purchases",
    status: input.decision.materiality.archiveContext
      ? "blocked"
      : input.decision.materiality.thinSignal
        ? "watch"
        : "met",
    reason: input.decision.materiality.archiveContext
      ? "Geo is inactive or immaterial for live authority."
      : input.decision.materiality.thinSignal
        ? "Thin-signal GEOs stay on the opportunity board until deeper conversion proof exists."
        : null,
  });
  const freshnessFloor = buildDecisionEvidenceFloor({
    key: "freshness",
    label: "Freshness",
    current:
      input.decision.freshness.dataState === "ready"
        ? input.decision.freshness.isPartial
          ? "ready / partial"
          : "ready / fresh"
        : input.decision.freshness.dataState,
    required: "ready and not stale",
    status:
      input.decision.freshness.dataState === "ready"
        ? input.decision.freshness.isPartial
          ? "watch"
          : "met"
        : "blocked",
    reason:
      input.decision.freshness.dataState === "ready"
        ? input.decision.freshness.isPartial
          ? "Source is partial, so this GEO should not graduate into queue authority yet."
          : null
        : input.decision.freshness.reason ??
          "Source freshness is stale for the live GEO decision window.",
  });
  const commercialFloor = buildDecisionEvidenceFloor({
    key: "commercial_context",
    label: "Commercial context",
    current: input.decision.commercialContext.countryEconomicsConfigured
      ? `${input.decision.commercialContext.serviceability ?? "unknown"} / ${input.decision.commercialContext.scaleOverride ?? "default"}`
      : "global cost structure",
    required: "global cost structure or configured country override",
    status: !input.decision.commercialContext.countryEconomicsConfigured
      ? "met"
      : input.decision.commercialContext.serviceability == null
        ? "watch"
        : "met",
    reason: !input.decision.commercialContext.countryEconomicsConfigured
      ? "Country economics are not configured; all locations use the same global cost structure."
      : input.decision.commercialContext.serviceability == null
        ? "Country economics exist, but this GEO has no explicit serviceability row yet."
        : null,
  });
  const actionFloor = buildDecisionEvidenceFloor({
    key: "queue_readiness",
    label: "Queue readiness",
    current: input.decision.action,
    required: "decisive action with live authority",
    status: input.decision.queueEligible
      ? "met"
      : input.decision.action === "pool" ||
          input.decision.action === "validate" ||
          input.decision.action === "monitor"
        ? "watch"
        : "blocked",
    reason: input.decision.queueEligible
      ? null
      : input.decision.action === "pool" ||
          input.decision.action === "validate" ||
          input.decision.action === "monitor"
        ? "Validation and pooled GEO paths stay visible, but outside the default queue."
        : "This GEO still lacks the authority floor required for queue intake.",
  });

  return [signalFloor, freshnessFloor, commercialFloor, actionFloor];
}

function buildMetaOpportunityBoard(input: {
  campaigns: MetaCampaignDecision[];
  adSets: MetaAdSetDecision[];
  geoDecisions: MetaGeoDecision[];
  winnerScaleCandidates: MetaWinnerScaleCandidate[];
  noTouchList: MetaNoTouchItem[];
  thresholds: TargetThresholds;
}) {
  const items: MetaOpportunityBoardItem[] = [];
  const campaignById = new Map(input.campaigns.map((campaign) => [campaign.campaignId, campaign]));
  const adSetById = new Map(input.adSets.map((adSet) => [adSet.adSetId, adSet]));

  for (const decision of input.geoDecisions) {
    const evidenceFloors = buildMetaGeoOpportunityFloors({ decision });
    const queue = evaluateDecisionOpportunityQueue({
      truthState: decision.trust.truthState,
      authorityReady: decision.trust.surfaceLane === "action_core",
      floors: evidenceFloors,
      blockedReasons:
        decision.trust.truthState === "degraded_missing_truth"
          ? decision.trust.reasons
          : [],
      watchReasons:
        decision.trust.surfaceLane === "watchlist" && !decision.queueEligible
          ? decision.trust.reasons
          : [],
    });
    items.push({
      opportunityId: `meta-geo:${decision.geoKey}`,
      kind: "geo",
      title: decision.clusterLabel ?? decision.label,
      summary: decision.why,
      recommendedAction: decision.action,
      confidence: decision.confidence,
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: [
        "geo_issues",
        ...(decision.action === "cut" || decision.action === "isolate"
          ? ["high_risk_actions"]
          : []),
      ],
      trust: buildMetaOpportunityTrust({
        baseTrust: decision.trust,
        reasons: [
          decision.why,
          ...(queue.blockedReasons[0] ? [queue.blockedReasons[0]] : []),
        ],
      }),
      source: {
        entityType: "geo",
        entityId: decision.geoKey,
        groupKey: decision.clusterKey,
      },
      relatedEntities: [
        {
          type: "geo",
          id: decision.geoKey,
          label: decision.label,
        },
      ],
    });
  }

  const campaignCandidateGroups = new Map<string, MetaWinnerScaleCandidate[]>();
  for (const candidate of input.winnerScaleCandidates) {
    const existing = campaignCandidateGroups.get(candidate.campaignId);
    if (existing) existing.push(candidate);
    else campaignCandidateGroups.set(candidate.campaignId, [candidate]);
  }

  for (const [campaignId, candidates] of campaignCandidateGroups) {
    const campaign = campaignById.get(campaignId);
    if (!campaign) continue;
    const sortedCandidates = candidates
      .slice()
      .sort((left, right) => right.confidence - left.confidence);
    const bestCandidate = sortedCandidates[0];
    if (!bestCandidate) continue;
    const evidenceFloors = [
      buildDecisionEvidenceFloor({
        key: "winner_count",
        label: "Winner count",
        current: `${sortedCandidates.length} ad set`,
        required: "1+ authoritative winner",
        met: sortedCandidates.length > 0,
      }),
      buildDecisionEvidenceFloor({
        key: "commercial_truth",
        label: "Commercial truth",
        current: campaign.trust.truthState.replaceAll("_", " "),
        required: "live confident",
        met: campaign.trust.truthState === "live_confident",
        reason: "Campaign-level growth stays off-queue until commercial truth is fully authoritative.",
      }),
      buildDecisionEvidenceFloor({
        key: "efficiency",
        label: "Efficiency",
        current: formatRatio(bestCandidate.supportingMetrics.roas),
        required: formatRatio(input.thresholds.targetRoas),
        met: bestCandidate.supportingMetrics.roas >= input.thresholds.targetRoas,
        reason: "Campaign winner board requires at least one ad set still beating the target threshold.",
      }),
    ];
    const queue = evaluateDecisionOpportunityQueue({
      truthState: campaign.trust.truthState,
      authorityReady:
        campaign.trust.surfaceLane === "action_core" &&
        sortedCandidates.some((candidate) => {
          const adSet = adSetById.get(candidate.adSetId);
          return adSet?.trust.surfaceLane === "action_core";
        }),
      floors: evidenceFloors,
      blockedReasons:
        campaign.trust.truthState === "degraded_missing_truth"
          ? campaign.trust.reasons
          : [],
    });
    items.push({
      opportunityId: `meta-campaign-winner:${campaignId}`,
      kind: "campaign_winner_scale",
      title: campaign.campaignName,
      summary:
        sortedCandidates.length > 1
          ? `${sortedCandidates.length} ad sets are carrying scalable winner signal in this campaign.`
          : bestCandidate.why,
      recommendedAction: "scale_budget",
      confidence: clampConfidence(
        average([
          campaign.confidence,
          ...sortedCandidates.map((candidate) => candidate.confidence),
        ]),
      ),
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: ["scale_promotions"],
      trust: buildMetaOpportunityTrust({
        baseTrust: campaign.trust,
        reasons: [campaign.why],
      }),
      source: {
        entityType: "campaign",
        entityId: campaignId,
        groupKey: campaignId,
      },
      relatedEntities: [
        {
          type: "campaign",
          id: campaignId,
          label: campaign.campaignName,
        },
        ...sortedCandidates.slice(0, 3).map((candidate) => ({
          type: "adset" as const,
          id: candidate.adSetId,
          label: candidate.adSetName,
        })),
      ],
    });
  }

  for (const candidate of input.winnerScaleCandidates) {
    const adSet = adSetById.get(candidate.adSetId);
    const fallbackTrust =
      adSet?.trust ??
      campaignById.get(candidate.campaignId)?.trust ??
      compileDecisionTrust({
        surfaceLane: "watchlist",
        truthState: "degraded_missing_truth",
        operatorDisposition: "degraded_no_scale",
        reasons: [candidate.why],
      });
    const evidenceFloors = [
      buildDecisionEvidenceFloor({
        key: "signal_depth",
        label: "Signal depth",
        current: `${formatCurrency(candidate.supportingMetrics.spend)} / ${candidate.supportingMetrics.purchases} purchases`,
        required: "$250 spend and 6 purchases",
        met:
          candidate.supportingMetrics.spend >= 250 &&
          candidate.supportingMetrics.purchases >= 6,
        reason: "Winner-scale intake needs both spend depth and purchase depth.",
      }),
      buildDecisionEvidenceFloor({
        key: "efficiency",
        label: "Efficiency",
        current: formatRatio(candidate.supportingMetrics.roas),
        required: formatRatio(input.thresholds.targetRoas),
        met: candidate.supportingMetrics.roas >= input.thresholds.targetRoas,
        reason: "Winner-scale intake only stays queue-ready while it still beats the target threshold.",
      }),
      buildDecisionEvidenceFloor({
        key: "commercial_truth",
        label: "Commercial truth",
        current: adSet?.trust.truthState.replaceAll("_", " ") ?? "unavailable",
        required: "live confident",
        met: adSet?.trust.truthState === "live_confident",
        reason: "Shared authority still caps this ad set out of the default queue.",
      }),
    ];
    const queue = evaluateDecisionOpportunityQueue({
      truthState: adSet?.trust.truthState ?? "degraded_missing_truth",
      authorityReady: adSet?.trust.surfaceLane === "action_core" && !adSet?.noTouch,
      floors: evidenceFloors,
      blockedReasons:
        adSet?.trust.truthState === "degraded_missing_truth"
          ? adSet.trust.reasons
          : [],
    });
    items.push({
      opportunityId: `meta-adset-winner:${candidate.candidateId}`,
      kind: "adset_winner_scale",
      title: candidate.adSetName,
      summary: candidate.why,
      recommendedAction: candidate.policy.strategyClass,
      confidence: candidate.confidence,
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: ["scale_promotions"],
      trust: buildMetaOpportunityTrust({
        baseTrust: fallbackTrust,
        reasons: [candidate.why],
      }),
      source: {
        entityType: "adset",
        entityId: candidate.adSetId,
        groupKey: candidate.campaignId,
      },
      relatedEntities: [
        {
          type: "campaign",
          id: candidate.campaignId,
          label: candidate.campaignName,
        },
        {
          type: "adset",
          id: candidate.adSetId,
          label: candidate.adSetName,
        },
      ],
    });
  }

  for (const item of input.noTouchList) {
    const baseTrust =
      item.entityType === "campaign"
        ? campaignById.get(item.entityId)?.trust
        : item.entityType === "adset"
          ? adSetById.get(item.entityId)?.trust
          : input.geoDecisions.find((decision) => decision.countryCode === item.entityId)?.trust;
    const evidenceFloors = [
      buildDecisionEvidenceFloor({
        key: "winner_protection",
        label: "Winner protection",
        current: "protected",
        required: "stable winner context",
        met: true,
      }),
      buildDecisionEvidenceFloor({
        key: "queue_readiness",
        label: "Queue readiness",
        current: "hold_no_touch",
        required: "board-only guardrail",
        status: "blocked",
        reason: "Protected winners stay visible as guardrail context, not as queue work.",
      }),
    ];
    const queue = evaluateDecisionOpportunityQueue({
      truthState: baseTrust?.truthState ?? "live_confident",
      authorityReady: false,
      floors: evidenceFloors,
    });
    items.push({
      opportunityId: `meta-protected:${item.entityType}:${item.entityId}`,
      kind: "protected_winner",
      title: item.label,
      summary: item.reason,
      recommendedAction: "hold_no_touch",
      confidence: item.confidence,
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: ["promo_mode_watchlist"],
      trust: buildMetaOpportunityTrust({
        baseTrust:
          baseTrust ??
          compileDecisionTrust({
            surfaceLane: "watchlist",
            truthState: "live_confident",
            operatorDisposition: "protected_watchlist",
            reasons: [item.reason],
          }),
        reasons: [item.reason],
      }),
      source: {
        entityType: item.entityType,
        entityId: item.entityId,
        groupKey: null,
      },
      relatedEntities: [
        {
          type:
            item.entityType === "campaign"
              ? "campaign"
              : item.entityType === "adset"
                ? "adset"
                : "geo",
          id: item.entityId,
          label: item.label,
        },
      ],
    });
  }

  return items.sort(
    (left, right) =>
      Number(right.queue.eligible) - Number(left.queue.eligible) ||
      right.confidence - left.confidence ||
      left.title.localeCompare(right.title),
  );
}

function buildBudgetShifts(input: {
  campaigns: MetaCampaignDecision[];
  campaignRows: MetaCampaignRow[];
  winnerScaleCandidates: MetaWinnerScaleCandidate[];
  provenanceContext: MetaDecisionProvenanceContext;
}) {
  const byId = new Map(input.campaignRows.map((campaign) => [campaign.id, campaign]));
  const eligibleCampaigns = input.campaigns.filter(
    (campaign) => campaign.trust.surfaceLane === "action_core",
  );
  const donors = eligibleCampaigns.filter((campaign) =>
    campaign.primaryAction === "pause" || campaign.primaryAction === "reduce_budget",
  );
  const recipientCandidateByCampaign = new Map<
    string,
    { campaign: MetaCampaignDecision; candidate: MetaWinnerScaleCandidate }
  >();
  for (const candidate of input.winnerScaleCandidates) {
    const campaign = eligibleCampaigns.find(
      (decision) => decision.campaignId === candidate.campaignId,
    );
    if (!campaign) continue;
    const existing = recipientCandidateByCampaign.get(candidate.campaignId);
    if (!existing || candidate.confidence > existing.candidate.confidence) {
      recipientCandidateByCampaign.set(candidate.campaignId, { campaign, candidate });
    }
  }
  const recipients = Array.from(recipientCandidateByCampaign.values()).sort(
    (left, right) =>
      right.candidate.confidence - left.candidate.confidence ||
      right.candidate.supportingMetrics.roas - left.candidate.supportingMetrics.roas,
  );
  const maxRows = Math.min(donors.length, recipients.length, 4);
  const shifts: MetaBudgetShift[] = [];
  const availableRecipients = recipients.map((entry) => entry.campaign);

  for (let index = 0; index < maxRows; index += 1) {
    const donor = donors[index];
    const recipientIndex = availableRecipients.findIndex(
      (candidate) => candidate.campaignId !== donor?.campaignId,
    );
    const recipient =
      recipientIndex >= 0
        ? availableRecipients.splice(recipientIndex, 1)[0]
        : null;
    const donorRow = byId.get(donor.campaignId);
    const recipientRow = recipient ? byId.get(recipient.campaignId) : null;
    if (!donor || !recipient || !donorRow || !recipientRow) continue;
    const movePct = donor.primaryAction === "pause" ? "20-30%" : "10-15%";
    const suggestedMoveBand = `${movePct} of current budget load`;
    const sourceDecisionId = `${donor.campaignId}:${recipient.campaignId}:budget_shift`;
    const evidence: MetaDecisionEvidence[] = [
      {
        label: "Move band",
        value: suggestedMoveBand,
        impact: "neutral",
      },
      {
        label: "Donor action",
        value: donor.primaryAction,
        impact: donor.primaryAction === "pause" ? "negative" : "mixed",
      },
      {
        label: "Recipient role",
        value: recipient.role,
        impact: "positive",
      },
    ];
    const provenance = buildMetaDecisionProvenance({
      businessId: input.provenanceContext.businessId,
      decisionAsOf: input.provenanceContext.decisionAsOf,
      analyticsWindow: input.provenanceContext.analyticsWindow,
      reportingRange: input.provenanceContext.reportingRange,
      sourceWindow: input.provenanceContext.sourceWindow,
      sourceRowScope: {
        system: "meta",
        entityType: "budget_shift",
        entityId: `${donor.campaignId}:${recipient.campaignId}`,
      },
      sourceDecisionId,
      recommendedAction: "budget_shift",
      evidence,
      hashEvidence: {
        fromCampaignId: donor.campaignId,
        toCampaignId: recipient.campaignId,
        donorAction: donor.primaryAction,
        donorConfidence: donor.confidence,
        recipientRole: recipient.role,
        recipientConfidence: recipient.confidence,
        suggestedMoveBand,
      },
    });
    shifts.push({
      fromCampaignId: donor.campaignId,
      fromCampaignName: donor.campaignName,
      toCampaignId: recipient.campaignId,
      toCampaignName: recipient.campaignName,
      from: donor.campaignName,
      to: recipient.campaignName,
      whyNow:
        donor.primaryAction === "pause"
          ? "A clear loser exists, so the released budget should move into the cleanest winner path."
          : "The donor is below target while the recipient has the stronger case for controlled growth.",
      riskLevel: donor.primaryAction === "pause" ? "medium" : "low",
      expectedBenefit: `${recipient.role} can absorb cleaner spend than ${donor.role} right now.`,
      suggestedMoveBand,
      confidence: clampConfidence((donor.confidence + recipient.confidence) / 2),
      guardrails: [
        "Treat this as a read-only budget board, not an automatic write-back plan.",
        "Re-check the winner/loser pair after the first move band is absorbed.",
      ],
      provenance,
      evidenceHash: provenance.evidenceHash,
      actionFingerprint: provenance.actionFingerprint,
    });
  }

  return shifts;
}

function buildNoTouchList(input: {
  campaigns: MetaCampaignDecision[];
  adSets: MetaAdSetDecision[];
  geoDecisions: MetaGeoDecision[];
}) {
  const items: MetaNoTouchItem[] = [];
  for (const campaign of input.campaigns.filter((row) => row.noTouch)) {
    items.push({
      entityType: "campaign",
      entityId: campaign.campaignId,
      label: campaign.campaignName,
      reason: "Stable winner path. Do not mix testing or restructuring into this campaign right now.",
      confidence: campaign.confidence,
      guardrails: campaign.guardrails,
    });
  }
  for (const adSet of input.adSets.filter((row) => row.noTouch)) {
    items.push({
      entityType: "adset",
      entityId: adSet.adSetId,
      label: adSet.adSetName,
      reason: "Stable winner path. Protect this ad set from unnecessary edits.",
      confidence: adSet.confidence,
      guardrails: adSet.guardrails,
    });
  }
  for (const geo of input.geoDecisions.filter(
    (row) =>
      (row.action === "isolate" || row.action === "scale") &&
      row.trust.truthState === "live_confident",
  )) {
    if (geo.confidence < 0.82) continue;
    items.push({
      entityType: "geo",
      entityId: geo.countryCode,
      label: geo.label,
      reason: "This GEO is carrying enough value that it should stay protected while other moves happen around it.",
      confidence: geo.confidence,
      guardrails: geo.guardrails,
    });
  }
  return items.slice(0, 8);
}

function buildSummary(input: {
  campaignDecisions: MetaCampaignDecision[];
  adSetDecisions: MetaAdSetDecision[];
  budgetShifts: MetaBudgetShift[];
  geoDecisions: MetaGeoDecision[];
  noTouchList: MetaNoTouchItem[];
  winnerScaleCandidates: MetaWinnerScaleCandidate[];
  opportunityBoard: MetaOpportunityBoardItem[];
  operatingMode: AccountOperatingModePayload | null;
  geoFreshness: MetaGeoSourceFreshness;
  commercialTruth: BusinessCommercialTruthSnapshot;
}): MetaDecisionOsSummary {
  const commercialCoverage = input.commercialTruth.coverage;
  const readinessMissingInputs = input.operatingMode?.missingInputs ?? [];
  const readinessExpectedDays = META_DECISION_ENGINE_READY_WINDOW_DAYS;
  const topAdSetActions = [...input.adSetDecisions]
    .filter((decision) => decision.trust.surfaceLane === "action_core")
    .sort(
      (left, right) =>
        ACTION_PRIORITY[left.actionType] - ACTION_PRIORITY[right.actionType] ||
        right.confidence - left.confidence,
    )
    .slice(0, 3);
  const todayPlan = [
    ...topAdSetActions.map(
      (decision) =>
        `${decision.campaignName} / ${decision.adSetName}: ${decision.actionType.replaceAll("_", " ")}`,
    ),
    ...input.geoDecisions
      .filter((geo) => geo.trust.surfaceLane === "action_core")
      .filter((geo) => geo.action !== "monitor")
      .slice(0, 2)
      .map((geo) => `${geo.label}: ${geo.action}`),
  ].slice(0, 5);
  const surfaceRows = [
    ...input.campaignDecisions.map((decision) => decision.trust),
    ...input.adSetDecisions.map((decision) => decision.trust),
    ...input.geoDecisions.map((decision) => decision.trust),
  ];
  const pooledClusterCount = new Set(
    input.geoDecisions
      .filter((decision) => decision.grouped && decision.clusterKey)
      .map((decision) => decision.clusterKey),
  ).size;
  const sourceHealth: DecisionSourceHealthEntry[] = [
    {
      source: "Geo source",
      status:
        input.geoFreshness.dataState === "ready"
          ? input.geoFreshness.isPartial
            ? "stale"
            : "healthy"
          : input.geoFreshness.reason?.toLowerCase().includes("timeout")
            ? "timeout"
            : "degraded",
      detail:
        input.geoFreshness.reason ??
        (input.geoFreshness.isPartial
          ? "Geo source is partially ready, so pooled and validation reads stay labeled."
          : "Geo source is ready for the current decision window."),
      fallbackLabel: input.geoFreshness.isPartial ? "partial fallback" : null,
    },
    {
      source: "Commercial truth",
      status:
        commercialCoverage?.freshness.status === "fresh"
          ? "healthy"
          : commercialCoverage?.freshness.status === "stale"
            ? "stale"
            : "degraded",
      detail:
        commercialCoverage?.freshness.reason ??
        "Commercial truth is configured for the current decision window.",
      fallbackLabel:
        commercialCoverage?.freshness.status === "fresh"
          ? null
          : "shared trust ceiling",
    },
  ];
  const readReliability: DecisionReadReliability =
    input.geoFreshness.dataState === "ready" &&
    !input.geoFreshness.isPartial &&
    (commercialCoverage?.freshness.status ?? "missing") === "fresh"
      ? {
          status: "stable",
          determinism: "stable",
          detail:
            "Repeated reads should stay stable because both provider freshness and shared commercial truth are current.",
        }
      : input.geoFreshness.reason?.toLowerCase().includes("timeout")
        ? {
            status: "degraded",
            determinism: "unstable",
            detail:
              "A timeout or stale upstream source is forcing labeled fallback posture instead of queue promotion.",
          }
        : {
            status: "fallback",
            determinism: "watch",
            detail:
              "The surface is still readable, but operators should expect board-only or trust-capped outcomes until freshness improves.",
          };
  const readiness: DecisionSurfaceReadiness = {
    daysExpected: readinessExpectedDays,
    daysReady:
      readReliability.status === "stable"
        ? readinessExpectedDays
        : readReliability.status === "fallback"
          ? Math.max(
              10,
              readinessExpectedDays -
                Math.max(1, readinessMissingInputs.length) * 5,
            )
          : Math.max(3, readinessExpectedDays - 24),
    missingInputs: readinessMissingInputs,
    suppressedActionClasses: Array.from(
      new Set(
        [
          ...(commercialCoverage?.actionCeilings ?? []),
          ...surfaceRows
            .filter((row) => row.operatorDisposition === "profitable_truth_capped")
            .map(() => "scale_budget"),
        ].filter(Boolean),
      ),
    ),
    previewCoverage: null,
  };

  return {
    todayPlanHeadline:
      topAdSetActions.length > 0
        ? `Today's plan centers on ${topAdSetActions[0].actionType.replaceAll("_", " ")}.`
        : "Today's plan is to hold while more clean signal accumulates.",
    todayPlan,
    budgetShiftSummary:
      input.budgetShifts.length > 0
        ? `${input.budgetShifts.length} explainable budget shift candidate${input.budgetShifts.length > 1 ? "s" : ""} are ready.`
        : "No clean budget shift pair is ready yet.",
    noTouchSummary:
      input.noTouchList.length > 0
        ? `${input.noTouchList.length} winner path${input.noTouchList.length > 1 ? "s are" : " is"} marked no-touch.`
        : "No protected no-touch path is active yet.",
    winnerScaleSummary: {
      candidateCount: input.winnerScaleCandidates.length,
      protectedCount: input.noTouchList.filter(
        (item) => item.entityType === "campaign" || item.entityType === "adset",
      ).length,
      headline:
        input.winnerScaleCandidates.length > 0
          ? `${input.winnerScaleCandidates.length} active winner scale candidate${input.winnerScaleCandidates.length > 1 ? "s are" : " is"} ready for controlled growth.`
          : "No clean winner scale candidate is ready yet.",
    },
    operatingMode: input.operatingMode
      ? {
          currentMode: input.operatingMode.currentMode,
          recommendedMode: input.operatingMode.recommendedMode,
          confidence: input.operatingMode.confidence,
        }
      : null,
    confidence: clampConfidence(
      topAdSetActions.length > 0
        ? topAdSetActions.reduce((sum, decision) => sum + decision.confidence, 0) / topAdSetActions.length
        : 0.56,
    ),
    sourceHealth,
    readReliability,
    surfaceSummary: {
      actionCoreCount:
        input.budgetShifts.length +
        surfaceRows.filter((row) => row.surfaceLane === "action_core").length,
      watchlistCount: surfaceRows.filter((row) => row.surfaceLane === "watchlist").length,
      archiveCount: surfaceRows.filter((row) => row.surfaceLane === "archive_context").length,
      degradedCount: surfaceRows.filter(
        (row) => row.truthState === "degraded_missing_truth",
      ).length,
      profitableTruthCappedCount: surfaceRows.filter(
        (row) => row.operatorDisposition === "profitable_truth_capped",
      ).length,
    },
    readiness,
    opportunitySummary: {
      totalCount: input.opportunityBoard.length,
      queueEligibleCount: input.opportunityBoard.filter(
        (item) => item.queue.eligible,
      ).length,
      geoCount: input.opportunityBoard.filter((item) => item.kind === "geo").length,
      winnerScaleCount: input.opportunityBoard.filter(
        (item) =>
          item.kind === "campaign_winner_scale" ||
          item.kind === "adset_winner_scale",
      ).length,
      protectedCount: input.opportunityBoard.filter(
        (item) => item.kind === "protected_winner",
      ).length,
      headline:
        input.opportunityBoard.filter((item) => item.queue.eligible).length > 0
          ? `${input.opportunityBoard.filter((item) => item.queue.eligible).length} opportunity-board item${input.opportunityBoard.filter((item) => item.queue.eligible).length > 1 ? "s are" : " is"} queue-ready with evidence floors met.`
          : "Opportunity board is populated, but no item is ready for queue intake yet.",
    },
    geoSummary: {
      actionCoreCount: input.geoDecisions.filter(
        (decision) => decision.trust.surfaceLane === "action_core",
      ).length,
      watchlistCount: input.geoDecisions.filter(
        (decision) => decision.trust.surfaceLane === "watchlist",
      ).length,
      queuedCount: input.geoDecisions.filter((decision) => decision.queueEligible).length,
      pooledClusterCount,
      sourceFreshness: input.geoFreshness,
      countryEconomics: {
        configured: input.commercialTruth.sectionMeta.countryEconomics.configured,
        updatedAt: input.commercialTruth.sectionMeta.countryEconomics.updatedAt,
        sourceLabel: input.commercialTruth.sectionMeta.countryEconomics.sourceLabel,
      },
    },
  };
}

export function buildMetaDecisionOs(
  input: BuildMetaDecisionOsInput,
): MetaDecisionOsV1Response {
  const analyticsStartDate = input.analyticsStartDate ?? input.startDate;
  const analyticsEndDate = input.analyticsEndDate ?? input.endDate;
  const decisionAsOf = input.decisionAsOf ?? input.endDate;
  const decisionMetadata = {
    ...buildOperatorDecisionMetadata({
      analyticsStartDate,
      analyticsEndDate,
      decisionAsOf,
    }),
    ...(input.analyticsWindow ? { analyticsWindow: input.analyticsWindow } : {}),
    ...(input.decisionWindows ? { decisionWindows: input.decisionWindows } : {}),
    ...(input.historicalMemory ? { historicalMemory: input.historicalMemory } : {}),
    ...(input.decisionAsOf ? { decisionAsOf: input.decisionAsOf } : {}),
  };
  const provenanceContext: MetaDecisionProvenanceContext = {
    businessId: input.businessId,
    decisionAsOf: decisionMetadata.decisionAsOf,
    analyticsWindow: decisionMetadata.analyticsWindow,
    reportingRange: {
      startDate: input.startDate,
      endDate: input.endDate,
    },
    sourceWindow: decisionMetadata.decisionWindows.primary30d,
    evidenceSource: input.evidenceSource ?? "unknown",
  };
  const thresholds = determineThresholds(input.commercialTruth);
  const commercialTruthCoverage = collectCommercialTruthCoverage(input.commercialTruth);
  const laneByCampaignId = buildMetaCampaignLaneSignals(input.campaigns);
  const activePromoNames = input.commercialTruth.promoCalendar
    .filter((promo) =>
      isPromoActiveOnDate(
        promo.startDate,
        promo.endDate,
        decisionMetadata.decisionAsOf,
      ),
    )
    .map((promo) => normalizeText(`${promo.title} ${promo.affectedScope ?? ""}`))
    .filter(Boolean);
  const operatingMode = buildOperatingModeSummary({
    ...input,
    analyticsWindow: decisionMetadata.analyticsWindow,
    decisionAsOf: decisionMetadata.decisionAsOf,
  });
  const geoFreshness =
    input.geoSource?.freshness ?? resolveDefaultGeoSourceFreshness(input);
  const geoRows = input.geoSource?.rows ?? input.breakdowns?.location ?? [];
  const accountRoas =
    input.campaigns.reduce((sum, campaign) => sum + campaign.revenue, 0) /
    Math.max(1, input.campaigns.reduce((sum, campaign) => sum + campaign.spend, 0));
  const totalGeoSpend = geoRows.reduce((sum, row) => sum + row.spend, 0);
  const campaignById = new Map(input.campaigns.map((campaign) => [campaign.id, campaign]));

  const campaignRoleById = new Map<string, CampaignRoleDecision>();
  for (const campaign of input.campaigns) {
    campaignRoleById.set(
      campaign.id,
      classifyCampaignRole({
        campaign,
        laneLabel: laneByCampaignId.get(campaign.id)?.lane ?? null,
        activePromoNames,
      }),
    );
  }

  const adSetDecisions = input.adSets.map((adSet) =>
    buildAdSetDecision({
      adSet,
      campaign: campaignById.get(adSet.campaignId) ?? null,
      campaignRole: campaignRoleById.get(adSet.campaignId)?.role ?? "Prospecting Validation",
      thresholds,
      commercialTruth: input.commercialTruth,
      geoCoverageMode: commercialTruthCoverage.mode,
      operatingMode,
      decisionAsOf: decisionMetadata.decisionAsOf,
      provenanceContext,
    }),
  );

  const campaignDecisions = input.campaigns.map((campaign) => {
    const roleDecision = campaignRoleById.get(campaign.id) ?? {
      role: "Prospecting Validation" as const,
      confidence: 0.58,
      why: "No stronger role signal exists.",
    };
    const relatedAdSets = adSetDecisions.filter((decision) => decision.campaignId === campaign.id);
    return buildCampaignDecision({
      campaign,
      laneLabel: laneByCampaignId.get(campaign.id)?.lane ?? null,
      roleDecision,
      adSetDecisions: relatedAdSets,
      thresholds,
      operatingMode,
      provenanceContext,
    });
  });

  const winnerScaleCandidateSeed = buildWinnerScaleCandidates({
    adSetDecisions,
  });
  const geoDecisions = hydrateGeoClusters(
    geoRows
    .map((row) =>
      buildGeoAction({
        row,
        accountRoas: Number.isFinite(accountRoas) ? accountRoas : 0,
        snapshot: input.commercialTruth,
        thresholds,
        geoFreshness,
        totalGeoSpend,
        provenanceContext,
      }),
    )
    .sort((left, right) => right.confidence - left.confidence),
  );
  const placementAnomalies = buildPlacementAnomalies({
    rows: input.breakdowns?.placement ?? [],
    accountRoas: Number.isFinite(accountRoas) ? accountRoas : 0,
    provenanceContext,
  });
  const noTouchList = buildNoTouchList({
    campaigns: campaignDecisions,
    adSets: adSetDecisions,
    geoDecisions,
  });
  const opportunityBoard = buildMetaOpportunityBoard({
    campaigns: campaignDecisions,
    adSets: adSetDecisions,
    geoDecisions,
    winnerScaleCandidates: winnerScaleCandidateSeed,
    noTouchList,
    thresholds,
  });
  const winnerScaleCandidates = winnerScaleCandidateSeed.filter((candidate) =>
    opportunityBoard.some(
      (item) =>
        item.kind === "adset_winner_scale" &&
        item.source.entityId === candidate.adSetId &&
        item.queue.eligible,
    ),
  );
  const derivedNoTouchList = noTouchList.filter((item) =>
    opportunityBoard.some(
      (boardItem) =>
        boardItem.kind === "protected_winner" &&
        boardItem.source.entityType === item.entityType &&
        boardItem.source.entityId === item.entityId,
    ),
  );
  const budgetShifts = buildBudgetShifts({
    campaigns: campaignDecisions,
    campaignRows: input.campaigns,
    winnerScaleCandidates,
    provenanceContext,
  });
  const summary = buildSummary({
    campaignDecisions,
    adSetDecisions,
    budgetShifts,
    geoDecisions,
    noTouchList: derivedNoTouchList,
    winnerScaleCandidates,
    opportunityBoard,
    operatingMode,
    geoFreshness,
    commercialTruth: input.commercialTruth,
  });
  const authority = buildDecisionSurfaceAuthority({
    scope: "Meta Decision OS",
    truthState:
      commercialTruthCoverage.missingInputs.length > 0
        ? "degraded_missing_truth"
        : "live_confident",
    completeness:
      commercialTruthCoverage.missingInputs.length === 0
        ? "complete"
        : commercialTruthCoverage.missingInputs.length >= 3
          ? "missing"
          : "partial",
    freshness: buildDecisionFreshness({
      status:
        geoFreshness.dataState === "ready"
          ? geoFreshness.isPartial
            ? "partial"
            : "fresh"
          : geoFreshness.reason?.toLowerCase().includes("timeout")
            ? "timeout"
            : "stale",
      updatedAt: geoFreshness.lastSyncedAt,
      reason: geoFreshness.reason,
    }),
    missingInputs: commercialTruthCoverage.missingInputs,
    reasons: commercialTruthCoverage.notes,
    actionCoreCount: summary.surfaceSummary.actionCoreCount,
    watchlistCount: summary.surfaceSummary.watchlistCount,
    archiveCount: summary.surfaceSummary.archiveCount,
    suppressedCount:
      summary.surfaceSummary.watchlistCount + summary.surfaceSummary.archiveCount,
    note:
      commercialTruthCoverage.missingInputs.length > 0
        ? "Meta Decision OS remains available but trust-capped by missing commercial truth."
        : "Meta Decision OS is operating on the live decision window with shared trust-kernel suppression.",
    readiness: summary.readiness,
    sourceHealth: summary.sourceHealth,
    readReliability: summary.readReliability,
  });

  return {
    contractVersion: META_DECISION_OS_V1_CONTRACT,
    generatedAt: new Date().toISOString(),
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    analyticsWindow: decisionMetadata.analyticsWindow,
    decisionWindows: decisionMetadata.decisionWindows,
    historicalMemory: decisionMetadata.historicalMemory,
    decisionAsOf: decisionMetadata.decisionAsOf,
    summary,
    campaigns: campaignDecisions.sort((left, right) => right.confidence - left.confidence),
    adSets: adSetDecisions.sort(
      (left, right) =>
        ACTION_PRIORITY[left.actionType] - ACTION_PRIORITY[right.actionType] ||
        right.confidence - left.confidence,
    ),
    budgetShifts,
    geoDecisions,
    placementAnomalies,
    noTouchList: derivedNoTouchList,
    winnerScaleCandidates,
    opportunityBoard,
    commercialTruthCoverage,
    authority,
  };
}
