import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { getMetaAdSetsForRange } from "@/lib/meta/adsets-source";
import type { getMetaBreakdownsForRange } from "@/lib/meta/breakdowns-source";
import { buildOperatorDecisionMetadata } from "@/lib/operator-decision-metadata";
import { buildOperatorDecisionProvenance } from "@/lib/operator-decision-provenance";
import {
  buildDecisionFreshness,
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
import { resolveCreativePreviewManifest } from "@/lib/meta/creatives-preview";
import {
  assessCreativeOperatorPolicy,
  type CreativeEvidenceSource,
  type CreativeOperatorPolicyAssessment,
  type CreativeOperatorRelativeBaseline,
  type CreativeRelativeBaselineReliability,
} from "@/lib/creative-operator-policy";
import type { AccountOperatingModePayload, BusinessCommercialTruthSnapshot } from "@/src/types/business-commercial";
import type {
  OperatorAnalyticsWindow,
  OperatorDecisionProvenance,
  OperatorDecisionWindows,
  OperatorHistoricalMemory,
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
import {
  buildMetaCampaignLaneSignals,
  comparableMetaIntentKey,
  metaCampaignFamilyLabel,
  resolveMetaCampaignFamily,
  type MetaCampaignFamily,
  type MetaCampaignLaneLabel,
} from "@/lib/meta/campaign-lanes";

type MetaAdSetRow = Awaited<ReturnType<typeof getMetaAdSetsForRange>>["rows"][number];
type MetaBreakdownRow = Awaited<ReturnType<typeof getMetaBreakdownsForRange>>["location"][number];
type MetaCampaignLaneSignalMap = ReturnType<typeof buildMetaCampaignLaneSignals>;

export const CREATIVE_DECISION_OS_CONTRACT_VERSION = "creative-decision-os.v1";
export const CREATIVE_DECISION_OS_ENGINE_VERSION = "2026-04-11-phase-05-v2";

export type CreativeDecisionAction = "scale_hard" | "scale" | "watch" | "test_more" | "pause" | "kill";
export type LegacyCreativeLifecycleState =
  | "stable_winner"
  | "emerging_winner"
  | "volatile"
  | "fatigued_winner"
  | "test_only"
  | "blocked";
export type CreativeDecisionLifecycleState =
  | "incubating"
  | "validating"
  | "scale_ready"
  | "stable_winner"
  | "fatigued_winner"
  | "blocked"
  | "retired"
  | "comeback_candidate";
export type CreativeDecisionPrimaryAction =
  | "promote_to_scaling"
  | "keep_in_test"
  | "hold_no_touch"
  | "refresh_replace"
  | "block_deploy"
  | "retest_comeback";
export type CreativeDecisionFamilySource =
  | "story_identity"
  | "asset_identity"
  | "copy_signature"
  | "singleton";
export type CreativeDecisionBenchmarkCohort =
  | "family"
  | "family_format"
  | "format_age"
  | "format_spend_maturity"
  | "meta_campaign_family"
  | "format"
  | "account";
export type CreativeDecisionGeoContext = "scale" | "validate" | "pool" | "isolate" | "none";
export type CreativeFatigueStatus = "none" | "watch" | "fatigued" | "unknown";
export type CreativeDecisionAdSetRole =
  | "scaling_hero"
  | "validation_challenger"
  | "test_probe"
  | "refresh_replacement"
  | "hold_position"
  | "blocked"
  | null;
export type CreativeDecisionEconomicsStatus = "eligible" | "guarded" | "blocked";
export type CreativeDecisionDeploymentCompatibilityStatus =
  | "compatible"
  | "limited"
  | "blocked";
export type CreativeDecisionFamilyConfidence = "high" | "medium" | "low";
export type CreativeDecisionOverGroupingRisk = "low" | "medium" | "high";
export type CreativeDecisionSupplyPlanKind =
  | "new_test_concepts"
  | "refresh_existing_winner"
  | "expand_angle_family"
  | "revive_comeback";
export type CreativeDecisionSupplyPlanPriority = "high" | "medium" | "low";
export type CreativeDecisionPolicyDriver =
  | "protected_winner"
  | "fatigue"
  | "comeback"
  | "economics"
  | "deployment_match"
  | "commercial_truth"
  | "test_validation";

export interface CreativeDecisionOsHistoricalWindow {
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
}

export interface CreativeDecisionOsHistoricalWindows {
  last3?: CreativeDecisionOsHistoricalWindow | null;
  last7?: CreativeDecisionOsHistoricalWindow | null;
  last14?: CreativeDecisionOsHistoricalWindow | null;
  last30?: CreativeDecisionOsHistoricalWindow | null;
  last90?: CreativeDecisionOsHistoricalWindow | null;
  allHistory?: CreativeDecisionOsHistoricalWindow | null;
}

export interface CreativeDecisionOsInputRow {
  creativeId: string;
  name: string;
  creativeFormat?: "image" | "video" | "catalog";
  previewUrl?: string | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cardPreviewUrl?: string | null;
  cachedThumbnailUrl?: string | null;
  previewManifest?: import("@/lib/meta/creatives-types").CreativePreviewManifest | null;
  creativeAgeDays: number;
  spendVelocity: number;
  frequency: number;
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpm: number;
  cpc: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  hookRate: number;
  holdRate: number;
  video25Rate: number;
  watchRate: number;
  video75Rate: number;
  clickToPurchaseRate: number;
  atcToPurchaseRate: number;
  copyText?: string | null;
  copyVariants?: string[];
  headlineVariants?: string[];
  descriptionVariants?: string[];
  objectStoryId?: string | null;
  effectiveObjectStoryId?: string | null;
  postId?: string | null;
  accountId?: string | null;
  accountName?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adSetId?: string | null;
  adSetName?: string | null;
  taxonomyPrimaryLabel?: string | null;
  taxonomySecondaryLabel?: string | null;
  taxonomyVisualFormat?: string | null;
  aiTags?: Partial<Record<string, string[]>>;
  historicalWindows?: CreativeDecisionOsHistoricalWindows | null;
}

export interface CreativeDecisionDeliveryContext {
  campaignStatus: string | null;
  adSetStatus: string | null;
  campaignName: string | null;
  adSetName: string | null;
  campaignIsTestLike: boolean;
  activeDelivery: boolean;
  pausedDelivery: boolean;
}

export interface CreativeDecisionBenchmarkMetric {
  current: number | null;
  benchmark: number | null;
  deltaPct: number | null;
  status: "better" | "near" | "worse" | "unknown";
}

export interface CreativeDecisionBenchmark {
  selectedCohort: CreativeDecisionBenchmarkCohort;
  selectedCohortLabel: string;
  sampleSize: number;
  fallbackChain: CreativeDecisionBenchmarkCohort[];
  missingContext: string[];
  metrics: {
    roas: CreativeDecisionBenchmarkMetric;
    cpa: CreativeDecisionBenchmarkMetric;
    ctr: CreativeDecisionBenchmarkMetric;
    clickToPurchase: CreativeDecisionBenchmarkMetric;
    attention: CreativeDecisionBenchmarkMetric & { label: string };
  };
}

export type CreativeDecisionBenchmarkScope = "account" | "campaign";
export type CreativeDecisionBenchmarkSource =
  | "account_default"
  | "explicit_campaign_scope";

export interface CreativeDecisionBenchmarkScopeInput {
  scope: CreativeDecisionBenchmarkScope;
  scopeId?: string | null;
  scopeLabel?: string | null;
}

export interface CreativeDecisionBenchmarkScopeMetadata {
  benchmarkScope: CreativeDecisionBenchmarkScope;
  benchmarkScopeLabel: string;
  benchmarkSource: CreativeDecisionBenchmarkSource;
  benchmarkScopeId: string | null;
  benchmarkReliability: CreativeRelativeBaselineReliability;
}

export interface CreativeDecisionRelativeBaseline
  extends CreativeOperatorRelativeBaseline {
  scope: CreativeDecisionBenchmarkScope;
  benchmarkKey: string;
  scopeId: string | null;
  scopeLabel: string;
  source: CreativeDecisionBenchmarkSource;
  reliability: CreativeRelativeBaselineReliability;
  sampleSize: number;
  creativeCount: number;
  eligibleCreativeCount: number;
  spendBasis: number | null;
  purchaseBasis: number | null;
  weightedRoas: number | null;
  weightedCpa: number | null;
  medianRoas: number | null;
  medianCpa: number | null;
  medianSpend: number | null;
  missingContext: string[];
}

export interface CreativeDecisionFatigue {
  status: CreativeFatigueStatus;
  confidence: number;
  ctrDecay: number | null;
  clickToPurchaseDecay: number | null;
  roasDecay: number | null;
  spendConcentration: number | null;
  frequencyPressure: number | null;
  winnerMemory: boolean;
  evidence: string[];
  missingContext: string[];
}

export interface CreativeDecisionDeploymentRecommendation {
  metaFamily: MetaCampaignFamily;
  metaFamilyLabel: string;
  targetLane: MetaCampaignLaneLabel | null;
  eligibleLanes?: MetaCampaignLaneLabel[];
  targetAdSetRole: CreativeDecisionAdSetRole;
  preferredCampaignIds: string[];
  preferredCampaignNames: string[];
  preferredAdSetIds: string[];
  preferredAdSetNames: string[];
  geoContext: CreativeDecisionGeoContext;
  constraints: string[];
  whatWouldChangeThisDecision: string[];
  queueVerdict?: DecisionOpportunityQueueVerdict;
  queueSummary?: string;
  blockedReasons?: string[];
  compatibility: {
    status: CreativeDecisionDeploymentCompatibilityStatus;
    objectiveFamily: string | null;
    optimizationGoal: string | null;
    bidRegime: string | null;
    matchedCampaignIds: string[];
    matchedAdSetIds: string[];
    reasons: string[];
  };
}

export interface CreativeDecisionEconomics {
  status: CreativeDecisionEconomicsStatus;
  absoluteSpendFloor: number;
  absolutePurchaseFloor: number;
  roasFloor: number | null;
  cpaCeiling: number | null;
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
  reasons: string[];
}

export interface CreativeDecisionPolicy {
  primaryDriver: CreativeDecisionPolicyDriver;
  objectiveFamily: string | null;
  bidRegime: string | null;
  metaFamily: MetaCampaignFamily;
  deploymentCompatibility: CreativeDecisionDeploymentCompatibilityStatus;
  explanation?: DecisionPolicyExplanation;
}

export interface CreativeDecisionFamilyProvenance {
  confidence: CreativeDecisionFamilyConfidence;
  overGroupingRisk: CreativeDecisionOverGroupingRisk;
  evidence: string[];
}

export interface CreativeDecisionPatternReference {
  hook: string;
  angle: string;
  format: string;
}

export type CreativeDecisionPreviewReviewState =
  | "ready"
  | "metrics_only_degraded"
  | "missing";

export interface CreativeDecisionPreviewStatus {
  selectedWindow: "ready" | "missing";
  liveDecisionWindow: CreativeDecisionPreviewReviewState;
  reason: string | null;
}

export interface CreativeRuleReportFactor {
  label: string;
  impact: "positive" | "negative" | "neutral";
  value: string;
  reason: string;
}

export interface CreativeRuleReportPayload {
  creativeId: string;
  creativeName: string;
  action: CreativeDecisionAction;
  lifecycleState?: LegacyCreativeLifecycleState;
  score: number;
  confidence: number;
  summary: string;
  coreVerdict?: string;
  accountContext: {
    roasAvg: number;
    cpaAvg: number;
    ctrAvg: number;
    spendMedian: number;
    spendP20: number;
    spendP80: number;
  };
  timeframeContext?: {
    coreVerdict: string;
    selectedRangeOverlay: string;
    historicalSupport: string;
    note?: string | null;
  };
  factors: CreativeRuleReportFactor[];
  family?: {
    familyId: string;
    familyLabel: string;
    familySource: CreativeDecisionFamilySource;
    memberCount: number;
  };
  benchmark?: CreativeDecisionBenchmark;
  fatigue?: CreativeDecisionFatigue;
  economics?: CreativeDecisionEconomics;
  deployment?: CreativeDecisionDeploymentRecommendation;
  deterministicDecision?: {
    lifecycleState: CreativeDecisionLifecycleState;
    primaryAction: CreativeDecisionPrimaryAction;
    legacyAction: CreativeDecisionAction;
  };
  commercialContext?: {
    operatingMode: AccountOperatingModePayload["recommendedMode"] | null;
    confidence: number;
    missingInputs: string[];
  };
  pattern?: CreativeDecisionPatternReference;
}

export interface CreativeDecisionOsCreative {
  creativeId: string;
  provenance: OperatorDecisionProvenance;
  evidenceHash: string;
  actionFingerprint: string;
  evidenceSource: CreativeEvidenceSource;
  operatorPolicy: CreativeOperatorPolicyAssessment;
  familyId: string;
  familyLabel: string;
  familySource: CreativeDecisionFamilySource;
  name: string;
  creativeFormat: "image" | "video" | "catalog";
  creativeAgeDays: number;
  spend: number;
  purchaseValue: number;
  roas: number;
  cpa: number;
  ctr: number;
  purchases: number;
  impressions: number;
  linkClicks: number;
  score: number;
  confidence: number;
  lifecycleState: CreativeDecisionLifecycleState;
  primaryAction: CreativeDecisionPrimaryAction;
  legacyAction: CreativeDecisionAction;
  legacyLifecycleState: LegacyCreativeLifecycleState;
  decisionSignals: string[];
  summary: string;
  relativeBaseline: CreativeDecisionRelativeBaseline;
  benchmarkScope: CreativeDecisionBenchmarkScope;
  benchmarkScopeLabel: string;
  benchmarkSource: CreativeDecisionBenchmarkSource;
  benchmarkReliability: CreativeRelativeBaselineReliability;
  benchmark: CreativeDecisionBenchmark;
  fatigue: CreativeDecisionFatigue;
  economics: CreativeDecisionEconomics;
  policy?: CreativeDecisionPolicy;
  familyProvenance: CreativeDecisionFamilyProvenance;
  deployment: CreativeDecisionDeploymentRecommendation;
  deliveryContext?: CreativeDecisionDeliveryContext;
  previewStatus?: CreativeDecisionPreviewStatus;
  pattern: CreativeDecisionPatternReference;
  report: CreativeRuleReportPayload;
  trust: DecisionTrustMetadata;
}

export interface CreativeDecisionOsFamily {
  familyId: string;
  familyLabel: string;
  familySource: CreativeDecisionFamilySource;
  creativeIds: string[];
  dominantFormat: string;
  lifecycleState: CreativeDecisionLifecycleState;
  primaryAction: CreativeDecisionPrimaryAction;
  totalSpend: number;
  totalPurchaseValue: number;
  totalPurchases: number;
  topAngles: string[];
  topHooks: string[];
  metaFamily: MetaCampaignFamily;
  metaFamilyLabel: string;
  provenance: CreativeDecisionFamilyProvenance;
}

export interface CreativeDecisionOsPattern {
  patternKey: string;
  hook: string;
  angle: string;
  format: string;
  creativeIds: string[];
  spend: number;
  purchaseValue: number;
  roas: number;
  lifecycleState: CreativeDecisionLifecycleState;
  confidence: number;
}

export interface CreativeDecisionLifecycleBoardItem {
  state: CreativeDecisionLifecycleState;
  label: string;
  count: number;
  creativeIds: string[];
}

export interface CreativeDecisionOperatorQueue {
  key: "promotion" | "keep_testing" | "fatigued_blocked" | "comeback";
  label: string;
  summary: string;
  count: number;
  creativeIds: string[];
}

export interface CreativeDecisionOsCommercialTruthCoverage {
  operatingMode: AccountOperatingModePayload["recommendedMode"] | null;
  confidence: number;
  missingInputs: string[];
  activeInputs: string[];
  guardrails: string[];
  configuredSections: {
    targetPack: boolean;
    countryEconomics: boolean;
    promoCalendar: boolean;
    operatingConstraints: boolean;
  };
  summary?: import("@/src/types/business-commercial").BusinessCommercialCoverageSummary;
}

export interface CreativeDecisionProtectedWinner {
  creativeId: string;
  familyId: string;
  creativeName: string;
  familyLabel: string;
  spend: number;
  roas: number;
  reasons: string[];
}

export interface CreativeDecisionSupplyPlanItem {
  kind: CreativeDecisionSupplyPlanKind;
  priority: CreativeDecisionSupplyPlanPriority;
  familyId: string;
  familyLabel: string;
  creativeIds: string[];
  summary: string;
  reasons: string[];
}

export type CreativeOpportunityKind =
  | "creative_family_winner_scale"
  | "protected_winner";

export interface CreativeOpportunityBoardItem {
  opportunityId: string;
  kind: CreativeOpportunityKind;
  title: string;
  summary: string;
  recommendedAction: string;
  confidence: number;
  queue: DecisionOpportunityQueueEligibility;
  eligibilityTrace: DecisionOpportunityQueueEligibility["eligibilityTrace"];
  evidenceFloors: DecisionEvidenceFloor[];
  tags: string[];
  trust: DecisionTrustMetadata;
  familyId: string;
  creativeIds: string[];
}

export interface CreativeHistoricalAnalysisSelectedWindow {
  startDate: string;
  endDate: string;
  rowCount: number;
  materialRowCount: number;
  note: string;
}

export interface CreativeHistoricalAnalysisBucket {
  label: string;
  creativeCount: number;
  spend: number;
  purchaseValue: number;
  purchases: number;
  roas: number;
  shareOfSpend: number;
  summary: string;
}

export interface CreativeHistoricalFamilyPerformance {
  familyId: string;
  familyLabel: string;
  familySource: CreativeDecisionFamilySource;
  creativeCount: number;
  dominantFormat: string;
  spend: number;
  purchaseValue: number;
  purchases: number;
  roas: number;
  topHook: string | null;
  topAngle: string | null;
  summary: string;
}

export interface CreativeHistoricalAnalysis {
  summary: string;
  selectedWindow: CreativeHistoricalAnalysisSelectedWindow;
  winningFormats: CreativeHistoricalAnalysisBucket[];
  hookTrends: CreativeHistoricalAnalysisBucket[];
  angleTrends: CreativeHistoricalAnalysisBucket[];
  familyPerformance: CreativeHistoricalFamilyPerformance[];
}

export interface CreativeDecisionOsV1Response {
  contractVersion: typeof CREATIVE_DECISION_OS_CONTRACT_VERSION;
  engineVersion: typeof CREATIVE_DECISION_OS_ENGINE_VERSION;
  generatedAt: string;
  businessId: string;
  startDate: string;
  endDate: string;
  analyticsWindow: OperatorAnalyticsWindow;
  decisionWindows: OperatorDecisionWindows;
  historicalMemory: OperatorHistoricalMemory;
  decisionAsOf: string;
  summary: {
    totalCreatives: number;
    scaleReadyCount: number;
    keepTestingCount: number;
    fatiguedCount: number;
    blockedCount: number;
    comebackCount: number;
    protectedWinnerCount: number;
    supplyPlanCount: number;
    message: string;
    operatingMode: AccountOperatingModePayload["recommendedMode"] | null;
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
      protectedCount: number;
      familyScaleCount: number;
      headline: string;
    };
    benchmarkScope: CreativeDecisionBenchmarkScopeMetadata;
  };
  creatives: CreativeDecisionOsCreative[];
  families: CreativeDecisionOsFamily[];
  patterns: CreativeDecisionOsPattern[];
  protectedWinners: CreativeDecisionProtectedWinner[];
  supplyPlan: CreativeDecisionSupplyPlanItem[];
  opportunityBoard: CreativeOpportunityBoardItem[];
  lifecycleBoard: CreativeDecisionLifecycleBoardItem[];
  operatorQueues: CreativeDecisionOperatorQueue[];
  commercialTruthCoverage: CreativeDecisionOsCommercialTruthCoverage;
  historicalAnalysis: CreativeHistoricalAnalysis;
  authority?: import("@/src/types/decision-trust").DecisionSurfaceAuthority;
}

interface BuildCreativeDecisionOsInput {
  businessId: string;
  startDate: string;
  endDate: string;
  evidenceSource?: CreativeEvidenceSource;
  analyticsWindow?: OperatorAnalyticsWindow;
  decisionWindows?: OperatorDecisionWindows;
  historicalMemory?: OperatorHistoricalMemory;
  decisionAsOf?: string;
  rows: CreativeDecisionOsInputRow[];
  campaigns?: MetaCampaignRow[];
  adSets?: MetaAdSetRow[];
  breakdowns?: { location?: MetaBreakdownRow[] | null } | null;
  commercialTruth?: BusinessCommercialTruthSnapshot | null;
  operatingMode?: AccountOperatingModePayload | null;
  benchmarkScope?: CreativeDecisionBenchmarkScopeInput | null;
  generatedAt?: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0] ?? 0;
  const index = (values.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const weight = index - lower;
  const lowerValue = values[lower] ?? values[values.length - 1] ?? 0;
  const upperValue = values[upper] ?? values[values.length - 1] ?? 0;
  return lowerValue + (upperValue - lowerValue) * weight;
}

function average(values: number[]) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length === 0) return 0;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "");
}

function normalizeMetaDeliveryStatus(value: string | null | undefined) {
  return value?.trim().toUpperCase() || null;
}

function isActiveMetaDeliveryStatus(value: string | null | undefined) {
  return normalizeMetaDeliveryStatus(value) === "ACTIVE";
}

function isPausedMetaDeliveryStatus(value: string | null | undefined) {
  const normalized = normalizeMetaDeliveryStatus(value);
  if (!normalized) return false;
  return (
    normalized.includes("PAUSED") ||
    normalized.includes("DISABLED") ||
    normalized.includes("ARCHIVED") ||
    normalized.includes("DELETED")
  );
}

function isTestLikeCampaignName(value: string | null | undefined) {
  const normalized = (value ?? "").toLowerCase().trim();
  if (!normalized) return false;
  return [
    "test",
    "testing",
    "creative test",
    "validation",
    "validasyon",
    "deneme",
    "deney",
  ].some((term) => normalized.includes(term));
}

function normalizeMediaKey(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function sum(values: number[]) {
  return values.reduce((acc, value) => acc + value, 0);
}

function sumBy<T>(rows: T[], pick: (row: T) => number) {
  return rows.reduce((acc, row) => acc + pick(row), 0);
}

function firstNonEmpty(values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function modeValue(values: Array<string | null | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function meanMetric(rows: CreativeDecisionOsInputRow[], pick: (row: CreativeDecisionOsInputRow) => number) {
  if (rows.length === 0) return 0;
  return average(rows.map(pick));
}

function pickAttentionMetric(row: CreativeDecisionOsInputRow) {
  if (row.creativeFormat === "video") {
    if (row.hookRate > 0) return { label: "Thumbstop", value: row.hookRate };
    if (row.video25Rate > 0) return { label: "Video 25%", value: row.video25Rate };
    if (row.watchRate > 0) return { label: "Watch rate", value: row.watchRate };
  }
  if (row.hookRate > 0) return { label: "Hook rate", value: row.hookRate };
  if (row.ctr > 0) return { label: "CTR", value: row.ctr };
  return { label: "Attention", value: 0 };
}

function statusFromDelta(deltaPct: number | null, direction: "high" | "low") {
  if (deltaPct === null || !Number.isFinite(deltaPct)) return "unknown" as const;
  const directionalDelta = direction === "low" ? -deltaPct : deltaPct;
  if (directionalDelta >= 0.15) return "better" as const;
  if (directionalDelta <= -0.15) return "worse" as const;
  return "near" as const;
}

function metricDelta(current: number, benchmark: number) {
  if (!Number.isFinite(current) || !Number.isFinite(benchmark) || benchmark <= 0) return null;
  return (current - benchmark) / benchmark;
}

function legacyLifecycleFromState(state: CreativeDecisionLifecycleState, legacyAction: CreativeDecisionAction): LegacyCreativeLifecycleState {
  if (state === "stable_winner") return "stable_winner";
  if (state === "scale_ready") return "emerging_winner";
  if (state === "fatigued_winner") return "fatigued_winner";
  if (state === "blocked" || state === "retired") return "blocked";
  if (state === "incubating" || state === "comeback_candidate") return "test_only";
  if (legacyAction === "test_more") return "test_only";
  return "volatile";
}

function legacyActionFromPrimary(input: {
  primaryAction: CreativeDecisionPrimaryAction;
  lifecycleState: CreativeDecisionLifecycleState;
  score: number;
  confidence: number;
}) {
  if (input.primaryAction === "promote_to_scaling") {
    return input.lifecycleState === "stable_winner" || (input.score >= 86 && input.confidence >= 0.76)
      ? "scale_hard"
      : "scale";
  }
  if (input.primaryAction === "keep_in_test" || input.primaryAction === "retest_comeback") {
    return "test_more";
  }
  if (input.primaryAction === "refresh_replace") {
    return "pause";
  }
  if (input.primaryAction === "block_deploy") {
    return input.lifecycleState === "blocked" ? "kill" : "pause";
  }
  return "watch";
}

function buildStoryIdentityKey(row: CreativeDecisionOsInputRow) {
  const storyId = row.effectiveObjectStoryId ?? row.objectStoryId ?? row.postId ?? null;
  return storyId ? `story:${storyId}` : null;
}

function buildAssetIdentityKey(row: CreativeDecisionOsInputRow) {
  const mediaKey = normalizeMediaKey(
    row.previewUrl ?? row.imageUrl ?? null,
  );
  return mediaKey ? `asset:${mediaKey}` : null;
}

function buildCopyIdentityKey(row: CreativeDecisionOsInputRow) {
  const format = normalizeText(row.creativeFormat ?? row.taxonomyVisualFormat ?? null);
  const primaryTaxonomy = normalizeText(row.taxonomyPrimaryLabel ?? null);
  const headline = normalizeText(row.headlineVariants?.[0] ?? null);
  const hook = normalizeText(row.aiTags?.hookTactic?.[0] ?? null);
  const angle = normalizeText(row.aiTags?.messagingAngle?.[0] ?? null);

  if (!format || !primaryTaxonomy) return null;
  if (headline) {
    return `copy:${format}|${primaryTaxonomy}|headline:${headline}`;
  }
  if (hook && angle) {
    return `copy:${format}|${primaryTaxonomy}|hook:${hook}|angle:${angle}`;
  }
  return null;
}

interface FamilySeed {
  familyId: string;
  familySource: CreativeDecisionFamilySource;
}

export function buildCreativeFamilySeeds(rows: CreativeDecisionOsInputRow[]) {
  const counts = new Map<string, number>();
  const recordCount = (key: string | null) => {
    if (!key) return;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };

  for (const row of rows) {
    recordCount(buildStoryIdentityKey(row));
    recordCount(buildAssetIdentityKey(row));
    recordCount(buildCopyIdentityKey(row));
  }

  const result = new Map<string, FamilySeed>();
  for (const row of rows) {
    const storyKey = buildStoryIdentityKey(row);
    if (storyKey && (counts.get(storyKey) ?? 0) >= 2) {
      result.set(row.creativeId, { familyId: storyKey, familySource: "story_identity" });
      continue;
    }
    const assetKey = buildAssetIdentityKey(row);
    if (assetKey && (counts.get(assetKey) ?? 0) >= 2) {
      result.set(row.creativeId, { familyId: assetKey, familySource: "asset_identity" });
      continue;
    }
    const copyKey = buildCopyIdentityKey(row);
    if (copyKey && (counts.get(copyKey) ?? 0) >= 2) {
      result.set(row.creativeId, { familyId: copyKey, familySource: "copy_signature" });
      continue;
    }
    result.set(row.creativeId, { familyId: `singleton:${row.creativeId}`, familySource: "singleton" });
  }
  return result;
}

export function chooseCreativeFamilyLabel(rows: CreativeDecisionOsInputRow[]) {
  const headline = rows
    .flatMap((row) => row.headlineVariants ?? [])
    .find((value) => normalizeText(value).length > 0);
  if (headline) return headline;
  const copy = rows
    .map((row) => row.copyText ?? row.copyVariants?.[0] ?? null)
    .find((value) => normalizeText(value).length > 0);
  if (copy) return copy;
  return rows[0]?.name ?? "Creative family";
}

function buildFamilyProvenance(
  familySeed: FamilySeed,
  familyRows: CreativeDecisionOsInputRow[],
): CreativeDecisionFamilyProvenance {
  const headline = normalizeText(familyRows[0]?.headlineVariants?.[0] ?? null);
  const hook = normalizeText(familyRows[0]?.aiTags?.hookTactic?.[0] ?? null);
  const angle = normalizeText(familyRows[0]?.aiTags?.messagingAngle?.[0] ?? null);
  if (familySeed.familySource === "story_identity") {
    return {
      confidence: "high",
      overGroupingRisk: "low",
      evidence: [
        `Shared story/post identity across ${familyRows.length} creatives.`,
        "Family precedence came from stable story identity.",
      ],
    };
  }
  if (familySeed.familySource === "asset_identity") {
    return {
      confidence: "high",
      overGroupingRisk: "low",
      evidence: [
        `Shared asset fingerprint across ${familyRows.length} creatives.`,
        "Grouping came from the same preview or image source.",
      ],
    };
  }
  if (familySeed.familySource === "copy_signature") {
    const exactHeadline = Boolean(headline);
    return {
      confidence: exactHeadline ? "medium" : "low",
      overGroupingRisk: exactHeadline && familyRows.length <= 3 ? "medium" : "high",
      evidence: [
        exactHeadline
          ? "Heuristic family matched same format, primary taxonomy, and normalized headline."
          : "Heuristic family matched same format, primary taxonomy, hook tactic, and messaging angle.",
        hook || angle ? `AI tag anchor: ${[hook, angle].filter(Boolean).join(" / ")}.` : "No story or asset identity matched.",
      ],
    };
  }
  return {
    confidence: "high",
    overGroupingRisk: "low",
    evidence: [
      "No shared story, asset, or heuristic signature matched.",
      "Creative remains a singleton family by design.",
    ],
  };
}

function ageBucket(ageDays: number) {
  if (ageDays <= 7) return "new";
  if (ageDays <= 21) return "learning";
  return "mature";
}

function buildBenchmarkMetric(current: number, benchmark: number, direction: "high" | "low"): CreativeDecisionBenchmarkMetric {
  const deltaPct = metricDelta(current, benchmark);
  return {
    current: round(current, 4),
    benchmark: benchmark > 0 ? round(benchmark, 4) : null,
    deltaPct: deltaPct === null ? null : round(deltaPct, 4),
    status: statusFromDelta(deltaPct, direction),
  };
}

function resolveGeoContext(mode: AccountOperatingModePayload["recommendedMode"] | null, action: CreativeDecisionPrimaryAction): CreativeDecisionGeoContext {
  if (action === "block_deploy") return "none";
  if (mode === "Margin Protect") return "isolate";
  if (action === "promote_to_scaling") return "scale";
  if (action === "keep_in_test" || action === "retest_comeback") return "validate";
  if (action === "refresh_replace") return "pool";
  return "pool";
}

function buildCommercialTruthCoverage(
  snapshot: BusinessCommercialTruthSnapshot | null | undefined,
  operatingMode: AccountOperatingModePayload | null | undefined,
): CreativeDecisionOsCommercialTruthCoverage {
  return {
    operatingMode: operatingMode?.recommendedMode ?? null,
    confidence: operatingMode?.confidence ?? 0.3,
    missingInputs: operatingMode?.missingInputs ?? [],
    activeInputs: operatingMode?.activeCommercialInputs.map((item) => `${item.label}: ${item.detail}`) ?? [],
    guardrails: operatingMode?.guardrails ?? [],
    configuredSections: {
      targetPack: snapshot?.sectionMeta.targetPack.configured ?? false,
      countryEconomics: snapshot?.sectionMeta.countryEconomics.configured ?? false,
      promoCalendar: snapshot?.sectionMeta.promoCalendar.configured ?? false,
      operatingConstraints: snapshot?.sectionMeta.operatingConstraints.configured ?? false,
    },
    summary: snapshot?.coverage,
  };
}

export function buildEmptyCreativeHistoricalAnalysis(input: {
  startDate: string;
  endDate: string;
  summary?: string;
}): CreativeHistoricalAnalysis {
  return {
    summary:
      input.summary ??
      "Selected-period historical analysis is unavailable for this range. This block stays descriptive and does not change deterministic Decision Signals.",
    selectedWindow: {
      startDate: input.startDate,
      endDate: input.endDate,
      rowCount: 0,
      materialRowCount: 0,
      note: "Analysis only. Live decisions continue to use the primary decision window.",
    },
    winningFormats: [],
    hookTrends: [],
    angleTrends: [],
    familyPerformance: [],
  };
}

function buildMetricContext(rows: CreativeDecisionOsInputRow[]) {
  const spendValues = rows.map((row) => row.spend).filter((value) => value > 0).sort((a, b) => a - b);
  const totalSpend = sumBy(rows, (row) => row.spend);
  const totalPurchaseValue = sumBy(rows, (row) => row.purchaseValue);
  const totalPurchases = sumBy(rows, (row) => row.purchases);
  const totalLinkClicks = sumBy(rows, (row) => row.linkClicks);

  return {
    roasAvg: totalSpend > 0 ? totalPurchaseValue / totalSpend : average(rows.map((row) => row.roas)),
    cpaAvg: totalPurchases > 0 ? totalSpend / totalPurchases : average(rows.map((row) => row.cpa).filter((value) => value > 0)),
    ctrAvg: average(rows.map((row) => row.ctr)),
    spendMedian: percentile(spendValues, 0.5),
    spendP20: percentile(spendValues, 0.2),
    spendP80: percentile(spendValues, 0.8),
    spendP75: percentile(spendValues, 0.75),
    accountAttentionAvg: average(rows.map((row) => pickAttentionMetric(row).value).filter((value) => value > 0)),
    clickToPurchaseAvg: average(rows.map((row) => row.clickToPurchaseRate).filter((value) => value > 0)),
  };
}

function benchmarkScopeKey(value: string | null | undefined) {
  const normalized = normalizeText(value);
  return normalized ? normalized.replace(/[^a-z0-9_-]/g, "-").slice(0, 80) : "all";
}

function resolveBenchmarkScopeMetadata(
  input: BuildCreativeDecisionOsInput,
  rows: CreativeDecisionOsInputRow[],
): CreativeDecisionBenchmarkScopeMetadata {
  const scope = input.benchmarkScope?.scope === "campaign" ? "campaign" : "account";
  if (scope === "campaign") {
    const scopeId = input.benchmarkScope?.scopeId?.trim() || null;
    const firstCampaignName =
      scopeId
        ? rows.find((row) => row.campaignId === scopeId)?.campaignName ?? null
        : null;
    return {
      benchmarkScope: "campaign",
      benchmarkScopeId: scopeId,
      benchmarkScopeLabel:
        input.benchmarkScope?.scopeLabel?.trim() ||
        firstCampaignName ||
        (scopeId ? `Campaign ${scopeId}` : "Selected campaign"),
      benchmarkSource: "explicit_campaign_scope",
      benchmarkReliability: "unavailable",
    };
  }

  return {
    benchmarkScope: "account",
    benchmarkScopeId: null,
    benchmarkScopeLabel: "Account-wide",
    benchmarkSource: "account_default",
    benchmarkReliability: "unavailable",
  };
}

function buildUnavailableRelativeBaseline(input: {
  scopeMetadata: CreativeDecisionBenchmarkScopeMetadata;
  row: CreativeDecisionOsInputRow;
  reason: string;
}): CreativeDecisionRelativeBaseline {
  const scopeKey =
    input.scopeMetadata.benchmarkScope === "campaign"
      ? benchmarkScopeKey(input.scopeMetadata.benchmarkScopeId ?? input.row.campaignId)
      : "account";
  return {
    scope: input.scopeMetadata.benchmarkScope,
    benchmarkKey: `${input.scopeMetadata.benchmarkScope}:${scopeKey}`,
    scopeId:
      input.scopeMetadata.benchmarkScope === "campaign"
        ? input.scopeMetadata.benchmarkScopeId ?? input.row.campaignId ?? null
        : null,
    scopeLabel: input.scopeMetadata.benchmarkScopeLabel,
    source: input.scopeMetadata.benchmarkSource,
    reliability: "unavailable",
    sampleSize: 0,
    creativeCount: 0,
    eligibleCreativeCount: 0,
    spendBasis: null,
    purchaseBasis: null,
    weightedRoas: null,
    weightedCpa: null,
    medianRoas: null,
    medianCpa: null,
    medianSpend: null,
    missingContext: [input.reason],
  };
}

function buildRelativeBaseline(input: {
  row: CreativeDecisionOsInputRow;
  rows: CreativeDecisionOsInputRow[];
  scopeMetadata: CreativeDecisionBenchmarkScopeMetadata;
}): CreativeDecisionRelativeBaseline {
  const { row, scopeMetadata } = input;
  if (scopeMetadata.benchmarkScope === "campaign") {
    if (!scopeMetadata.benchmarkScopeId) {
      return buildUnavailableRelativeBaseline({
        scopeMetadata,
        row,
        reason: "Explicit campaign benchmark scope is missing a campaign id.",
      });
    }
    if (row.campaignId !== scopeMetadata.benchmarkScopeId) {
      return buildUnavailableRelativeBaseline({
        scopeMetadata,
        row,
        reason: "Creative is outside the explicit campaign benchmark scope.",
      });
    }
  }

  const scopeRows = input.rows.filter((candidate) => {
    if (candidate.creativeId === row.creativeId) return false;
    if (scopeMetadata.benchmarkScope === "campaign") {
      return candidate.campaignId === scopeMetadata.benchmarkScopeId;
    }
    return true;
  });
  const eligibleRows = scopeRows.filter(
    (candidate) =>
      candidate.spend > 0 &&
      (candidate.purchaseValue > 0 || candidate.roas > 0 || candidate.purchases > 0),
  );
  const spendBasis = sumBy(eligibleRows, (candidate) => candidate.spend);
  const purchaseBasis = sumBy(eligibleRows, (candidate) => candidate.purchases);
  const purchaseValueBasis = sumBy(eligibleRows, (candidate) => candidate.purchaseValue);
  const roasValues = eligibleRows
    .map((candidate) => candidate.roas)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const cpaValues = eligibleRows
    .map((candidate) => candidate.cpa)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const spendValues = eligibleRows
    .map((candidate) => candidate.spend)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const weightedRoas = spendBasis > 0 && purchaseValueBasis > 0
    ? purchaseValueBasis / spendBasis
    : null;
  const weightedCpa = purchaseBasis > 0 && spendBasis > 0
    ? spendBasis / purchaseBasis
    : null;
  const medianRoas = roasValues.length > 0 ? percentile(roasValues, 0.5) : null;
  const medianCpa = cpaValues.length > 0 ? percentile(cpaValues, 0.5) : null;
  const medianSpend = spendValues.length > 0 ? percentile(spendValues, 0.5) : null;
  const missingContext = [
    scopeRows.length < 3 ? "Fewer than 3 peer creatives in benchmark scope." : null,
    eligibleRows.length < 3 ? "Fewer than 3 eligible peer creatives with spend/revenue signal." : null,
    spendBasis < 150 ? "Benchmark spend basis below 150." : null,
    purchaseBasis < 3 ? "Benchmark purchase basis below 3." : null,
    weightedRoas === null || medianRoas === null ? "Benchmark ROAS basis unavailable." : null,
    medianSpend === null ? "Benchmark spend distribution unavailable." : null,
  ].filter((value): value is string => Boolean(value));

  const reliability: CreativeRelativeBaselineReliability =
    missingContext.length > 0
      ? eligibleRows.length === 0
        ? "unavailable"
        : "weak"
      : eligibleRows.length >= 6 && spendBasis >= 500 && purchaseBasis >= 8
        ? "strong"
        : "medium";
  const scopeKey =
    scopeMetadata.benchmarkScope === "campaign"
      ? benchmarkScopeKey(scopeMetadata.benchmarkScopeId)
      : "account";

  return {
    scope: scopeMetadata.benchmarkScope,
    benchmarkKey: `${scopeMetadata.benchmarkScope}:${scopeKey}`,
    scopeId:
      scopeMetadata.benchmarkScope === "campaign"
        ? scopeMetadata.benchmarkScopeId
        : null,
    scopeLabel: scopeMetadata.benchmarkScopeLabel,
    source: scopeMetadata.benchmarkSource,
    reliability,
    sampleSize: eligibleRows.length,
    creativeCount: scopeRows.length,
    eligibleCreativeCount: eligibleRows.length,
    spendBasis: spendBasis > 0 ? round(spendBasis, 2) : null,
    purchaseBasis: purchaseBasis > 0 ? round(purchaseBasis, 2) : null,
    weightedRoas: weightedRoas === null ? null : round(weightedRoas, 4),
    weightedCpa: weightedCpa === null ? null : round(weightedCpa, 4),
    medianRoas: medianRoas === null ? null : round(medianRoas, 4),
    medianCpa: medianCpa === null ? null : round(medianCpa, 4),
    medianSpend: medianSpend === null ? null : round(medianSpend, 2),
    missingContext,
  };
}

function aggregateBenchmarkReliability(
  baselines: CreativeDecisionRelativeBaseline[],
): CreativeRelativeBaselineReliability {
  if (baselines.some((baseline) => baseline.reliability === "strong")) return "strong";
  if (baselines.some((baseline) => baseline.reliability === "medium")) return "medium";
  if (baselines.some((baseline) => baseline.reliability === "weak")) return "weak";
  return "unavailable";
}

function buildHistoricalSummary(row: CreativeDecisionOsInputRow) {
  const windows = [
    row.historicalWindows?.last3,
    row.historicalWindows?.last7,
    row.historicalWindows?.last14,
    row.historicalWindows?.last30,
    row.historicalWindows?.last90,
    row.historicalWindows?.allHistory,
  ].filter((window): window is CreativeDecisionOsHistoricalWindow => Boolean(window));

  const strongCount = windows.filter((window) => window.roas >= 1.5 && window.purchases >= 1).length;
  const weakCount = windows.filter((window) => window.spend >= 50 && window.roas > 0 && window.roas < 0.9).length;
  const bestWindow = [...windows].sort((left, right) => right.roas - left.roas)[0] ?? null;
  const baselineRoas =
    windows.length > 0 ? average(windows.map((window) => window.roas).filter((value) => value > 0)) : row.roas;

  return {
    total: windows.length,
    strongCount,
    weakCount,
    bestWindow,
    baselineRoas,
  };
}

function resolveCampaignBidRegime(
  row: Pick<
    MetaCampaignRow,
    "bidStrategyType" | "bidStrategyLabel" | "bidValueFormat" | "manualBidAmount" | "bidValue"
  >,
) {
  const bidStrategy = normalizeText(row.bidStrategyType ?? row.bidStrategyLabel ?? null);
  if (bidStrategy.includes("cost cap")) return "cost_cap";
  if (bidStrategy.includes("bid cap")) return "bid_cap";
  if (bidStrategy.includes("highest value")) return "highest_value";
  if (bidStrategy.includes("lowest cost")) return "lowest_cost";
  if (row.bidValueFormat === "roas" || safeNumber(row.bidValue) > 0) return "roas_floor";
  if (safeNumber(row.manualBidAmount) > 0) return "manual_bid";
  return bidStrategy || null;
}

function resolveAdSetBidRegime(
  row: Pick<
    MetaAdSetRow,
    "bidStrategyType" | "bidStrategyLabel" | "bidValueFormat" | "manualBidAmount" | "bidValue"
  >,
) {
  const bidStrategy = normalizeText(row.bidStrategyType ?? row.bidStrategyLabel ?? null);
  if (bidStrategy.includes("cost cap")) return "cost_cap";
  if (bidStrategy.includes("bid cap")) return "bid_cap";
  if (bidStrategy.includes("highest value")) return "highest_value";
  if (bidStrategy.includes("lowest cost")) return "lowest_cost";
  if (row.bidValueFormat === "roas" || safeNumber(row.bidValue) > 0) return "roas_floor";
  if (safeNumber(row.manualBidAmount) > 0) return "manual_bid";
  return bidStrategy || null;
}

function resolveCampaignLane(
  campaign: MetaCampaignRow,
  laneSignals: MetaCampaignLaneSignalMap,
): MetaCampaignLaneLabel | null {
  const explicitLane = laneSignals.get(campaign.id)?.lane ?? null;
  if (explicitLane) return explicitLane;
  const name = normalizeText(campaign.name);
  if (name.includes("scal")) return "Scaling";
  if (name.includes("validat")) return "Validation";
  if (name.includes("test")) return "Test";
  return null;
}

function buildEconomics(
  row: CreativeDecisionOsInputRow,
  commercialTruth: BusinessCommercialTruthSnapshot | null | undefined,
) {
  const absoluteSpendFloor = 200;
  const absolutePurchaseFloor = 4;
  const fallbackRoasFloor = 2.0;
  const fallbackSpendFloor = 250;
  const fallbackPurchaseFloor = 5;
  const targetRoas = commercialTruth?.targetPack?.targetRoas ?? null;
  const breakEvenRoas = commercialTruth?.targetPack?.breakEvenRoas ?? null;
  const targetCpa = commercialTruth?.targetPack?.targetCpa ?? null;
  const breakEvenCpa = commercialTruth?.targetPack?.breakEvenCpa ?? null;
  const roasFloor =
    targetRoas ??
    (breakEvenRoas !== null ? round(breakEvenRoas + 0.15, 2) : fallbackRoasFloor);
  const cpaCeiling =
    targetCpa ??
    breakEvenCpa;
  const reasons: string[] = [];

  if (row.spend < absoluteSpendFloor) {
    reasons.push(`Promotion floor requires at least $${absoluteSpendFloor} spend.`);
  }
  if (row.purchases < absolutePurchaseFloor) {
    reasons.push(`Promotion floor requires at least ${absolutePurchaseFloor} purchases.`);
  }
  if (targetRoas !== null && row.roas < targetRoas) {
    reasons.push(`ROAS ${round(row.roas, 2)}x is below target ROAS ${round(targetRoas, 2)}x.`);
  } else if (targetRoas === null && breakEvenRoas !== null && row.roas < breakEvenRoas + 0.15) {
    reasons.push(
      `ROAS ${round(row.roas, 2)}x is below break-even + 0.15 (${round(breakEvenRoas + 0.15, 2)}x).`,
    );
  } else if (
    targetRoas === null &&
    breakEvenRoas === null &&
    (row.roas < fallbackRoasFloor || row.spend < fallbackSpendFloor || row.purchases < fallbackPurchaseFloor)
  ) {
    reasons.push(
      `Fallback promotion floor requires ${fallbackSpendFloor} spend, ${fallbackPurchaseFloor} purchases, and ${fallbackRoasFloor.toFixed(1)}x ROAS.`,
    );
  }

  if (cpaCeiling !== null && row.cpa > cpaCeiling) {
    reasons.push(`CPA ${round(row.cpa, 2)} is above ceiling ${round(cpaCeiling, 2)}.`);
  }

  const eligible =
    row.spend >= absoluteSpendFloor &&
    row.purchases >= absolutePurchaseFloor &&
    (targetRoas !== null
      ? row.roas >= targetRoas
      : breakEvenRoas !== null
        ? row.roas >= breakEvenRoas + 0.15
        : row.roas >= fallbackRoasFloor &&
          row.spend >= fallbackSpendFloor &&
          row.purchases >= fallbackPurchaseFloor) &&
    (cpaCeiling === null || row.cpa <= cpaCeiling);

  const guarded =
    !eligible &&
    row.spend >= 120 &&
    row.purchases >= 2 &&
    row.roas >= Math.max(1.2, breakEvenRoas ?? 1.2);

  return {
    status: eligible ? "eligible" : guarded ? "guarded" : "blocked",
    absoluteSpendFloor,
    absolutePurchaseFloor,
    roasFloor,
    cpaCeiling,
    targetRoas,
    breakEvenRoas,
    targetCpa,
    breakEvenCpa,
    reasons: reasons.slice(0, 4),
  } satisfies CreativeDecisionEconomics;
}

function selectBenchmark(
  row: CreativeDecisionOsInputRow,
  familyRows: CreativeDecisionOsInputRow[],
  allRows: CreativeDecisionOsInputRow[],
  metaFamily: MetaCampaignFamily,
) {
  const spendValues = allRows.map((item) => item.spend).filter((value) => value > 0).sort((a, b) => a - b);
  const p33 = percentile(spendValues, 0.33);
  const p66 = percentile(spendValues, 0.66);
  const spendBucket =
    row.spend <= p33 ? "low" : row.spend <= p66 ? "mid" : "high";

  const cohorts: Array<{
    key: CreativeDecisionBenchmarkCohort;
    label: string;
    rows: CreativeDecisionOsInputRow[];
  }> = [
    { key: "family", label: "Family", rows: familyRows.filter((candidate) => candidate.creativeId !== row.creativeId) },
    {
      key: "family_format",
      label: "Family + format",
      rows: familyRows.filter(
        (candidate) =>
          candidate.creativeId !== row.creativeId && candidate.creativeFormat === row.creativeFormat,
      ),
    },
    {
      key: "format_age",
      label: "Format + age",
      rows: allRows.filter(
        (candidate) =>
          candidate.creativeId !== row.creativeId &&
          candidate.creativeFormat === row.creativeFormat &&
          ageBucket(candidate.creativeAgeDays) === ageBucket(row.creativeAgeDays),
      ),
    },
    {
      key: "format_spend_maturity",
      label: "Format + spend maturity",
      rows: allRows.filter((candidate) => {
        const candidateBucket =
          candidate.spend <= p33 ? "low" : candidate.spend <= p66 ? "mid" : "high";
        return (
          candidate.creativeId !== row.creativeId &&
          candidate.creativeFormat === row.creativeFormat &&
          candidateBucket === spendBucket
        );
      }),
    },
    {
      key: "meta_campaign_family",
      label: "Meta family",
      rows: allRows.filter(
        (candidate) =>
          candidate.creativeId !== row.creativeId &&
          metaFamilyFromRow(candidate, new Map()) === metaFamily,
      ),
    },
    {
      key: "format",
      label: "Format",
      rows: allRows.filter(
        (candidate) =>
          candidate.creativeId !== row.creativeId && candidate.creativeFormat === row.creativeFormat,
      ),
    },
    {
      key: "account",
      label: "Account",
      rows: allRows.filter((candidate) => candidate.creativeId !== row.creativeId),
    },
  ];

  const fallbackChain: CreativeDecisionBenchmarkCohort[] = [];
  const missingContext: string[] = [];
  let selected = cohorts[cohorts.length - 1]!;

  for (const cohort of cohorts) {
    fallbackChain.push(cohort.key);
    const sampleSize = cohort.rows.length;
    const totalPurchases = sumBy(cohort.rows, (candidate) => candidate.purchases);
    const totalSpend = sumBy(cohort.rows, (candidate) => candidate.spend);
    if (sampleSize >= 2 && (totalPurchases >= 3 || totalSpend >= 150)) {
      selected = cohort;
      break;
    }
    missingContext.push(`${cohort.label} sample too thin`);
  }

  const selectedRows = selected.rows.length > 0 ? selected.rows : [row];
  const attentionRowValues = selectedRows.map((candidate) => pickAttentionMetric(candidate).value).filter((value) => value > 0);
  const attentionMetric = pickAttentionMetric(row);

  return {
    selectedCohort: selected.key,
    selectedCohortLabel: selected.label,
    sampleSize: selected.rows.length,
    fallbackChain,
    missingContext,
    metrics: {
      roas: buildBenchmarkMetric(row.roas, meanMetric(selectedRows, (candidate) => candidate.roas), "high"),
      cpa: buildBenchmarkMetric(row.cpa, meanMetric(selectedRows, (candidate) => candidate.cpa), "low"),
      ctr: buildBenchmarkMetric(row.ctr, meanMetric(selectedRows, (candidate) => candidate.ctr), "high"),
      clickToPurchase: buildBenchmarkMetric(
        row.clickToPurchaseRate,
        meanMetric(selectedRows, (candidate) => candidate.clickToPurchaseRate),
        "high",
      ),
      attention: {
        ...buildBenchmarkMetric(
          attentionMetric.value,
          attentionRowValues.length > 0 ? average(attentionRowValues) : attentionMetric.value,
          "high",
        ),
        label: attentionMetric.label,
      },
    },
  } satisfies CreativeDecisionBenchmark;
}

function buildFatigue(
  row: CreativeDecisionOsInputRow,
  familyRows: CreativeDecisionOsInputRow[],
  benchmark: CreativeDecisionBenchmark,
) {
  const historical = buildHistoricalSummary(row);
  const bestWindow = historical.bestWindow;
  const ctrDecay =
    bestWindow && bestWindow.ctr > 0 ? (bestWindow.ctr - row.ctr) / bestWindow.ctr : null;
  const clickToPurchaseDecay =
    bestWindow && bestWindow.clickToPurchaseRate > 0
      ? (bestWindow.clickToPurchaseRate - row.clickToPurchaseRate) / bestWindow.clickToPurchaseRate
      : null;
  const roasDecay =
    bestWindow && bestWindow.roas > 0 ? (bestWindow.roas - row.roas) / bestWindow.roas : null;
  const familySpend = sumBy(familyRows, (candidate) => candidate.spend);
  const spendConcentration = familySpend > 0 ? row.spend / familySpend : null;
  const frequencyPressure = row.frequency > 0 ? row.frequency : null;
  const missingContext: string[] = [];
  if (!bestWindow) missingContext.push("Historical winner window unavailable");
  if (!frequencyPressure) missingContext.push("Frequency unavailable");

  const decaySignals = [ctrDecay, clickToPurchaseDecay, roasDecay].filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  const significantDecayCount = decaySignals.filter((value) => value >= 0.18).length;
  const winnerMemory = historical.strongCount >= 2;
  const pressureSignals =
    (spendConcentration !== null && spendConcentration >= 0.55 ? 1 : 0) +
    (frequencyPressure !== null && frequencyPressure >= 2.5 ? 1 : 0);
  const benchmarkWeakening =
    benchmark.metrics.roas.status === "worse" && benchmark.metrics.clickToPurchase.status === "worse";

  let status: CreativeFatigueStatus = "none";
  if (!winnerMemory && historical.total === 0) {
    status = "unknown";
  } else if (winnerMemory && significantDecayCount >= 2 && (pressureSignals >= 1 || benchmarkWeakening)) {
    status = "fatigued";
  } else if (winnerMemory && (significantDecayCount >= 1 || benchmarkWeakening)) {
    status = "watch";
  }

  const evidence: string[] = [];
  if (ctrDecay !== null) evidence.push(`CTR decay ${Math.round(ctrDecay * 100)}% vs prior winner window.`);
  if (clickToPurchaseDecay !== null) {
    evidence.push(`Click-to-purchase decay ${Math.round(clickToPurchaseDecay * 100)}%.`);
  }
  if (roasDecay !== null) evidence.push(`ROAS decay ${Math.round(roasDecay * 100)}%.`);
  if (spendConcentration !== null) {
    evidence.push(`This creative carries ${Math.round(spendConcentration * 100)}% of family spend.`);
  }
  if (frequencyPressure !== null) {
    evidence.push(`Observed frequency ${round(frequencyPressure, 2)}.`);
  }

  let confidence = 0.48;
  if (winnerMemory) confidence += 0.16;
  if (significantDecayCount >= 2) confidence += 0.14;
  if (pressureSignals >= 1) confidence += 0.08;
  if (missingContext.length > 0) confidence -= 0.08;

  return {
    status,
    confidence: clamp(round(confidence, 2), 0.32, 0.9),
    ctrDecay: ctrDecay === null ? null : round(ctrDecay, 4),
    clickToPurchaseDecay: clickToPurchaseDecay === null ? null : round(clickToPurchaseDecay, 4),
    roasDecay: roasDecay === null ? null : round(roasDecay, 4),
    spendConcentration: spendConcentration === null ? null : round(spendConcentration, 4),
    frequencyPressure: frequencyPressure === null ? null : round(frequencyPressure, 4),
    winnerMemory,
    evidence: evidence.slice(0, 4),
    missingContext,
  } satisfies CreativeDecisionFatigue;
}

function metaFamilyFromRow(row: CreativeDecisionOsInputRow, campaignById: Map<string, MetaCampaignRow>) {
  const campaign = row.campaignId ? campaignById.get(row.campaignId) : null;
  if (campaign) return resolveMetaCampaignFamily(campaign);
  if ((row.taxonomyPrimaryLabel ?? "").toLowerCase().includes("lead")) return "lead";
  return "purchase_value";
}

function classifyLifecycle(input: {
  row: CreativeDecisionOsInputRow;
  benchmark: CreativeDecisionBenchmark;
  fatigue: CreativeDecisionFatigue;
  historical: ReturnType<typeof buildHistoricalSummary>;
  operatingMode: AccountOperatingModePayload | null | undefined;
}) {
  const { row, benchmark, fatigue, historical, operatingMode } = input;
  const lowSignal = row.spend < 120 || row.purchases < 2 || row.impressions < 5000;
  const severeCommercialBlock =
    operatingMode?.recommendedMode === "Recovery" ||
    operatingMode?.guardrails.some((guardrail) => guardrail.toLowerCase().includes("do not scale")) === true;

  if (row.spend < 10 && row.impressions < 500 && row.purchases === 0) {
    if (historical.strongCount >= 2) return "comeback_candidate" as const;
    return "retired" as const;
  }
  if (severeCommercialBlock) {
    return row.purchases > 0 && historical.strongCount >= 2
      ? ("fatigued_winner" as const)
      : ("blocked" as const);
  }
  if (
    benchmark.metrics.roas.status === "worse" &&
    benchmark.metrics.cpa.status === "worse" &&
    row.spend >= 150 &&
    row.purchases <= 1
  ) {
    return historical.strongCount >= 2 ? ("comeback_candidate" as const) : ("blocked" as const);
  }
  if (fatigue.status === "fatigued") return "fatigued_winner" as const;
  if (
    benchmark.metrics.roas.status === "better" &&
    benchmark.metrics.clickToPurchase.status !== "worse" &&
    row.purchases >= 3 &&
    row.spend >= 150
  ) {
    return historical.strongCount >= 2 ? ("stable_winner" as const) : ("scale_ready" as const);
  }
  if (lowSignal) return row.creativeAgeDays <= 10 ? ("incubating" as const) : ("validating" as const);
  return "validating" as const;
}

function decidePrimaryAction(
  lifecycleState: CreativeDecisionLifecycleState,
  operatingMode: AccountOperatingModePayload | null | undefined,
) {
  if (operatingMode?.recommendedMode === "Recovery" && lifecycleState !== "stable_winner") {
    return "block_deploy" as const;
  }
  if (lifecycleState === "scale_ready") return "promote_to_scaling" as const;
  if (lifecycleState === "stable_winner") return "hold_no_touch" as const;
  if (lifecycleState === "fatigued_winner") return "refresh_replace" as const;
  if (lifecycleState === "blocked" || lifecycleState === "retired") return "block_deploy" as const;
  if (lifecycleState === "comeback_candidate") return "retest_comeback" as const;
  return "keep_in_test" as const;
}

function resolvePrimaryAction(input: {
  lifecycleState: CreativeDecisionLifecycleState;
  baseAction: CreativeDecisionPrimaryAction;
  economics: CreativeDecisionEconomics;
  operatingMode: AccountOperatingModePayload | null | undefined;
  deployment: CreativeDecisionDeploymentRecommendation;
}) {
  if (input.baseAction !== "promote_to_scaling") {
    return input.baseAction;
  }
  if (input.operatingMode?.degradedMode.active) {
    return input.lifecycleState === "stable_winner" ? "hold_no_touch" : "keep_in_test";
  }
  if (input.economics.status !== "eligible") {
    return "keep_in_test";
  }
  if (input.deployment.compatibility.status === "compatible") {
    return "promote_to_scaling";
  }
  if (input.deployment.compatibility.status === "limited") {
    return "keep_in_test";
  }
  return "block_deploy";
}

function buildCreativeTrust(input: {
  row: CreativeDecisionOsInputRow;
  lifecycleState: CreativeDecisionLifecycleState;
  primaryAction: CreativeDecisionPrimaryAction;
  operatingMode: AccountOperatingModePayload | null | undefined;
  historical: ReturnType<typeof buildHistoricalSummary>;
  summary: string;
  deployment: CreativeDecisionDeploymentRecommendation;
}) {
  const lowMateriality =
    input.row.spend < 40 && input.row.purchases === 0 && input.row.impressions < 2_000;
  const archiveContext =
    input.lifecycleState === "retired" ||
    (lowMateriality &&
      input.primaryAction !== "retest_comeback" &&
      input.historical.strongCount === 0);
  const degradedMode = input.operatingMode?.degradedMode;
  const entityState = input.lifecycleState === "retired" ? "retired" : "active";
  const materiality = archiveContext
    ? "immaterial"
    : lowMateriality
      ? "thin_signal"
      : "material";
  const freshness = input.operatingMode?.authority?.freshness;
  const missingInputs = input.operatingMode?.missingInputs ?? [];

  if (archiveContext) {
    return compileDecisionTrust({
      surfaceLane: "archive_context",
      truthState: "inactive_or_immaterial",
      operatorDisposition: "archive_only",
      entityState,
      materiality,
      freshness,
      reasons: [
        input.lifecycleState === "retired"
          ? "Creative is retired from the live action core."
          : "Creative signal is too small for the default action core.",
        input.summary,
      ],
    });
  }

  if (input.primaryAction === "hold_no_touch") {
    return compileDecisionTrust({
      surfaceLane: "watchlist",
      truthState: "live_confident",
      operatorDisposition: "protected_watchlist",
      entityState,
      materiality,
      freshness,
      reasons: [input.summary],
    });
  }

  if (
    input.primaryAction === "block_deploy" &&
    input.lifecycleState !== "blocked" &&
    input.lifecycleState !== "retired"
  ) {
    return compileDecisionTrust({
      surfaceLane: "watchlist",
      truthState: "live_confident",
      operatorDisposition: "review_hold",
      entityState,
      materiality,
      freshness,
      reasons: [
        ...input.deployment.compatibility.reasons,
        input.summary,
      ],
    });
  }

  if (degradedMode?.active) {
    if (input.primaryAction === "promote_to_scaling") {
      return compileDecisionTrust({
        surfaceLane: "watchlist",
        truthState: "degraded_missing_truth",
        operatorDisposition: "profitable_truth_capped",
        entityState,
        materiality,
        freshness,
        missingInputs,
        reasons: [...degradedMode.reasons, input.summary],
      });
    }
    if (input.primaryAction === "keep_in_test") {
      if (input.lifecycleState === "scale_ready" || input.lifecycleState === "stable_winner") {
        return compileDecisionTrust({
          surfaceLane: "watchlist",
          truthState: "degraded_missing_truth",
          operatorDisposition: "profitable_truth_capped",
          entityState,
          materiality,
          freshness,
          missingInputs,
          reasons: [...degradedMode.reasons, input.summary],
        });
      }
      return compileDecisionTrust({
        surfaceLane: lowMateriality ? "watchlist" : "action_core",
        truthState: "degraded_missing_truth",
        operatorDisposition: lowMateriality ? "monitor_low_truth" : "review_hold",
        entityState,
        materiality,
        freshness,
        missingInputs,
        reasons: [...degradedMode.reasons, input.summary],
      });
    }
  }

  if (input.primaryAction === "keep_in_test" && lowMateriality) {
    return compileDecisionTrust({
      surfaceLane: "watchlist",
      truthState: "live_confident",
      operatorDisposition: "monitor_low_truth",
      entityState,
      materiality,
      freshness,
      reasons: [input.summary],
    });
  }

  return compileDecisionTrust({
    surfaceLane: "action_core",
    truthState: "live_confident",
    operatorDisposition: "standard",
    entityState,
    materiality,
    freshness,
    reasons: [input.summary],
  });
}

function buildDeployment(
  row: CreativeDecisionOsInputRow,
  input: {
    campaignsById: Map<string, MetaCampaignRow>;
    campaigns: MetaCampaignRow[];
    adSets: MetaAdSetRow[];
    locationRows: MetaBreakdownRow[];
    operatingMode: AccountOperatingModePayload | null | undefined;
    primaryAction: CreativeDecisionPrimaryAction;
    lifecycleState: CreativeDecisionLifecycleState;
    metaFamily: MetaCampaignFamily;
    confidence: number;
  },
): CreativeDecisionDeploymentRecommendation {
  const currentCampaign = row.campaignId ? input.campaignsById.get(row.campaignId) : null;
  const laneSignals = buildMetaCampaignLaneSignals(input.campaigns);
  const activeFamilyCampaigns = input.campaigns.filter(
    (campaign) =>
      campaign.status === "ACTIVE" &&
      resolveMetaCampaignFamily(campaign) === input.metaFamily,
  );

  const targetLane: MetaCampaignLaneLabel | null =
    input.primaryAction === "promote_to_scaling" || input.primaryAction === "hold_no_touch"
      ? "Scaling"
      : input.primaryAction === "keep_in_test"
        ? input.lifecycleState === "validating"
          ? "Validation"
          : "Test"
        : input.primaryAction === "retest_comeback"
          ? "Test"
          : null;

  const targetAdSetRole: CreativeDecisionAdSetRole =
    input.primaryAction === "promote_to_scaling"
      ? "scaling_hero"
      : input.primaryAction === "hold_no_touch"
        ? "hold_position"
        : input.primaryAction === "keep_in_test"
          ? input.lifecycleState === "validating"
            ? "validation_challenger"
            : "test_probe"
          : input.primaryAction === "retest_comeback"
            ? "test_probe"
            : input.primaryAction === "refresh_replace"
              ? "refresh_replacement"
              : "blocked";

  const currentIntentKey = currentCampaign ? comparableMetaIntentKey(currentCampaign) : null;
  const objectiveFamily =
    currentCampaign?.objective ??
    firstNonEmpty(activeFamilyCampaigns.map((campaign) => campaign.objective ?? null)) ??
    metaCampaignFamilyLabel(input.metaFamily);
  const optimizationGoal =
    currentCampaign?.optimizationGoal ??
    modeValue(activeFamilyCampaigns.map((campaign) => campaign.optimizationGoal)) ??
    null;
  const bidRegime =
    (currentCampaign ? resolveCampaignBidRegime(currentCampaign) : null) ??
    modeValue(activeFamilyCampaigns.map((campaign) => resolveCampaignBidRegime(campaign))) ??
    null;

  const laneMatchedCampaigns = targetLane
    ? activeFamilyCampaigns.filter((campaign) => resolveCampaignLane(campaign, laneSignals) === targetLane)
    : activeFamilyCampaigns;
  const intentMatchedCampaigns =
    currentIntentKey && laneMatchedCampaigns.length > 0
      ? laneMatchedCampaigns.filter((campaign) => comparableMetaIntentKey(campaign) === currentIntentKey)
      : [];
  const matchedCampaigns =
    intentMatchedCampaigns.length > 0 ? intentMatchedCampaigns : laneMatchedCampaigns;

  const matchedAdSets = input.adSets.filter((adSet) => {
    if (!matchedCampaigns.some((campaign) => campaign.id === adSet.campaignId)) return false;
    if (optimizationGoal && adSet.optimizationGoal && normalizeText(adSet.optimizationGoal) !== normalizeText(optimizationGoal)) {
      return false;
    }
    const adSetBidRegime = resolveAdSetBidRegime(adSet);
    if (bidRegime && adSetBidRegime && adSetBidRegime !== bidRegime) {
      return false;
    }
    return adSet.status === "ACTIVE";
  });

  const fallbackCampaigns = targetLane === "Scaling"
    ? activeFamilyCampaigns.filter((campaign) => {
        const lane = resolveCampaignLane(campaign, laneSignals);
        return lane === "Validation" || lane === "Test" || lane === null;
      })
    : [];
  const compatibilityReasons: string[] = [];
  if (activeFamilyCampaigns.length === 0) {
    compatibilityReasons.push(`No active ${metaCampaignFamilyLabel(input.metaFamily)} campaigns are available.`);
  } else if (targetLane && matchedCampaigns.length === 0) {
    compatibilityReasons.push(`No active ${targetLane.toLowerCase()} lane matched the current family.`);
  }
  if (currentIntentKey && laneMatchedCampaigns.length > 0 && intentMatchedCampaigns.length === 0) {
    compatibilityReasons.push("No active lane matched the same objective or optimization intent.");
  }
  if (optimizationGoal && matchedCampaigns.length > 0 && matchedAdSets.length === 0) {
    compatibilityReasons.push("Ad set optimization or bid regime did not align with the preferred target.");
  }

  const compatibilityStatus: CreativeDecisionDeploymentCompatibilityStatus =
    targetLane === null
      ? activeFamilyCampaigns.length > 0
        ? "compatible"
        : "limited"
      : matchedCampaigns.length > 0 && matchedAdSets.length > 0
        ? "compatible"
        : targetLane === "Scaling" && fallbackCampaigns.length > 0
          ? "limited"
          : activeFamilyCampaigns.length > 0
            ? "limited"
            : "blocked";
  const eligibleLanes = Array.from(
    new Set(
      activeFamilyCampaigns
        .map((campaign) => resolveCampaignLane(campaign, laneSignals))
        .filter((lane): lane is MetaCampaignLaneLabel => lane !== null),
    ),
  );

  const constraints = [...(input.operatingMode?.guardrails ?? [])];
  if (input.operatingMode?.recommendedMode === "Margin Protect") {
    constraints.push("Require stronger efficiency proof before widening delivery.");
  }
  if (input.primaryAction === "refresh_replace") {
    constraints.push("Do not redeploy the same fatigued asset without a refreshed concept.");
  }
  if (input.primaryAction === "block_deploy") {
    constraints.push("Deployment blocked until performance or commercial truth improves.");
  }

  const geoContext = resolveGeoContext(input.operatingMode?.recommendedMode ?? null, input.primaryAction);
  const topGeo = input.locationRows
    .filter((row) => safeNumber(row.spend) > 0)
    .sort((left, right) => safeNumber(right.spend) - safeNumber(left.spend))[0];
  const whatWouldChangeThisDecision = [
    ...(input.operatingMode?.changeTriggers ?? []),
    input.confidence < 0.62 ? "Higher signal depth would improve target precision." : "Keep monitoring efficiency drift after deployment.",
    topGeo ? `A major change in ${topGeo.label ?? topGeo.key} performance would re-rank the deployment lane.` : "Authoritative GEO context would sharpen deployment targeting.",
  ];
  const queueVerdict: DecisionOpportunityQueueVerdict =
    input.primaryAction === "hold_no_touch"
      ? "protected"
      : input.primaryAction === "promote_to_scaling" &&
          compatibilityStatus === "compatible"
        ? "queue_ready"
        : input.primaryAction === "promote_to_scaling" ||
            input.primaryAction === "keep_in_test" ||
            input.primaryAction === "retest_comeback"
          ? "board_only"
          : "blocked";
  const blockedReasons =
    compatibilityReasons.length > 0
      ? compatibilityReasons.slice(0, 4)
      : queueVerdict === "blocked"
        ? constraints.slice(0, 4)
        : [];
  const queueSummary =
    queueVerdict === "queue_ready"
      ? "Compatible lane and ad set coverage are present, so this can enter the default operator queue."
      : queueVerdict === "protected"
        ? "Winner stays visible for guardrails but is intentionally excluded from the active work queue."
        : queueVerdict === "blocked"
          ? blockedReasons[0] ?? "This creative is blocked from queue intake until deployment or truth blockers clear."
          : "This stays visible on the board for operator context, but it should not appear as default queue work.";

  return {
    metaFamily: input.metaFamily,
    metaFamilyLabel: metaCampaignFamilyLabel(input.metaFamily),
    targetLane,
    eligibleLanes,
    targetAdSetRole,
    preferredCampaignIds: input.confidence >= 0.56 ? matchedCampaigns.slice(0, 3).map((campaign) => campaign.id) : [],
    preferredCampaignNames: input.confidence >= 0.56 ? matchedCampaigns.slice(0, 3).map((campaign) => campaign.name) : [],
    preferredAdSetIds: input.confidence >= 0.64 ? matchedAdSets.slice(0, 4).map((adSet) => adSet.id) : [],
    preferredAdSetNames: input.confidence >= 0.64 ? matchedAdSets.slice(0, 4).map((adSet) => adSet.name) : [],
    geoContext,
    constraints: constraints.slice(0, 4),
    whatWouldChangeThisDecision: whatWouldChangeThisDecision.slice(0, 4),
    queueVerdict,
    queueSummary,
    blockedReasons,
    compatibility: {
      status: compatibilityStatus,
      objectiveFamily,
      optimizationGoal,
      bidRegime,
      matchedCampaignIds: matchedCampaigns.slice(0, 3).map((campaign) => campaign.id),
      matchedAdSetIds: matchedAdSets.slice(0, 4).map((adSet) => adSet.id),
      reasons: compatibilityReasons.slice(0, 4),
    },
  };
}

function buildCreativeDeliveryContext(
  row: CreativeDecisionOsInputRow,
  input: {
    campaignsById: Map<string, MetaCampaignRow>;
    adSets: MetaAdSetRow[];
  },
): CreativeDecisionDeliveryContext {
  const currentCampaign = row.campaignId ? input.campaignsById.get(row.campaignId) : null;
  const currentAdSet = row.adSetId
    ? input.adSets.find((adSet) => adSet.id === row.adSetId)
    : null;
  const campaignStatus = normalizeMetaDeliveryStatus(currentCampaign?.status ?? null);
  const adSetStatus = normalizeMetaDeliveryStatus(currentAdSet?.status ?? null);
  const activeDelivery = Boolean(
    adSetStatus
      ? isActiveMetaDeliveryStatus(adSetStatus) &&
          (campaignStatus == null || isActiveMetaDeliveryStatus(campaignStatus))
      : campaignStatus && isActiveMetaDeliveryStatus(campaignStatus),
  );
  const pausedDelivery =
    isPausedMetaDeliveryStatus(campaignStatus) || isPausedMetaDeliveryStatus(adSetStatus);
  const campaignName = currentCampaign?.name ?? row.campaignName ?? null;
  const adSetName = currentAdSet?.name ?? row.adSetName ?? null;

  return {
    campaignStatus,
    adSetStatus,
    campaignName,
    adSetName,
    campaignIsTestLike: isTestLikeCampaignName(campaignName),
    activeDelivery,
    pausedDelivery,
  };
}

function buildPattern(row: CreativeDecisionOsInputRow): CreativeDecisionPatternReference {
  return {
    hook: row.aiTags?.hookTactic?.[0] ?? row.headlineVariants?.[0] ?? row.taxonomyPrimaryLabel ?? "unlabeled_hook",
    angle: row.aiTags?.messagingAngle?.[0] ?? row.taxonomySecondaryLabel ?? "unlabeled_angle",
    format: row.creativeFormat ?? "image",
  };
}

function buildPreviewStatus(row: CreativeDecisionOsInputRow): CreativeDecisionPreviewStatus {
  const manifest = resolveCreativePreviewManifest({
    previewManifest: row.previewManifest ?? null,
    previewUrl: row.previewUrl ?? null,
    imageUrl: row.imageUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    tableThumbnailUrl: row.tableThumbnailUrl ?? null,
    cardPreviewUrl: row.cardPreviewUrl ?? null,
    cachedThumbnailUrl: row.cachedThumbnailUrl ?? null,
  });
  const selectedWindow = manifest?.render_state && manifest.render_state !== "missing"
    ? "ready"
    : "missing";

  if (manifest?.live_html_available) {
    return {
      selectedWindow,
      liveDecisionWindow: "ready",
      reason: "Live decision-window preview is available from Meta.",
    };
  }

  if (selectedWindow === "ready") {
    return {
      selectedWindow,
      liveDecisionWindow: "metrics_only_degraded",
      reason: "Static media is available, but live decision-window preview is degraded to metrics-only mode.",
    };
  }

  return {
    selectedWindow: "missing",
    liveDecisionWindow: "missing",
    reason: "No renderable preview sources are available for this creative.",
  };
}

function buildScore(
  row: CreativeDecisionOsInputRow,
  benchmark: CreativeDecisionBenchmark,
  fatigue: CreativeDecisionFatigue,
  lifecycleState: CreativeDecisionLifecycleState,
) {
  let score = 55;
  const roasStatus = benchmark.metrics.roas.status;
  const cpaStatus = benchmark.metrics.cpa.status;
  const ctrStatus = benchmark.metrics.ctr.status;
  const ctpStatus = benchmark.metrics.clickToPurchase.status;
  if (roasStatus === "better") score += 14;
  if (cpaStatus === "better") score += 9;
  if (ctrStatus === "better") score += 6;
  if (ctpStatus === "better") score += 8;
  if (row.purchases >= 4) score += 5;
  if (row.spend >= 200) score += 4;
  if (fatigue.status === "fatigued") score -= 20;
  if (fatigue.status === "watch") score -= 9;
  if (lifecycleState === "blocked") score -= 28;
  if (lifecycleState === "retired") score -= 18;
  if (lifecycleState === "comeback_candidate") score -= 8;
  return clamp(Math.round(score), 0, 100);
}

function buildConfidence(
  row: CreativeDecisionOsInputRow,
  benchmark: CreativeDecisionBenchmark,
  fatigue: CreativeDecisionFatigue,
  operatingMode: AccountOperatingModePayload | null | undefined,
) {
  let confidence = 0.42;
  if (row.purchases >= 3) confidence += 0.12;
  if (row.spend >= 150) confidence += 0.1;
  if (benchmark.sampleSize >= 3) confidence += 0.08;
  if (fatigue.status === "fatigued") confidence += 0.06;
  if (benchmark.missingContext.length > 2) confidence -= 0.08;
  if (operatingMode?.missingInputs.length) confidence -= 0.06;
  return clamp(round(confidence, 2), 0.3, 0.92);
}

function buildSignals(params: {
  lifecycleState: CreativeDecisionLifecycleState;
  primaryAction: CreativeDecisionPrimaryAction;
  benchmark: CreativeDecisionBenchmark;
  fatigue: CreativeDecisionFatigue;
  economics: CreativeDecisionEconomics;
  deployment: CreativeDecisionDeploymentRecommendation;
}) {
  const signals = [
    `Lifecycle: ${params.lifecycleState.replaceAll("_", " ")}`,
    `Primary decision: ${params.primaryAction.replaceAll("_", " ")}`,
    `Benchmark cohort: ${params.benchmark.selectedCohortLabel}`,
    `Deployment lane: ${params.deployment.targetLane ?? "none"}`,
    `Deployment compatibility: ${params.deployment.compatibility.status}`,
  ];
  if (params.fatigue.status !== "none") {
    signals.push(`Fatigue: ${params.fatigue.status}`);
  }
  if (params.economics.status !== "eligible") {
    signals.push(`Economics: ${params.economics.status}`);
  }
  return signals;
}

function buildSummary(
  primaryAction: CreativeDecisionPrimaryAction,
  lifecycleState: CreativeDecisionLifecycleState,
  benchmark: CreativeDecisionBenchmark,
  fatigue: CreativeDecisionFatigue,
  economics: CreativeDecisionEconomics,
  deployment: CreativeDecisionDeploymentRecommendation,
) {
  if (primaryAction === "promote_to_scaling") {
    return "Deterministic engine marks this creative as scale-ready for a Meta scaling lane.";
  }
  if (primaryAction === "hold_no_touch") {
    return "Deterministic engine marks this as a shipped winner that should stay protected.";
  }
  if (primaryAction === "refresh_replace") {
    return "Deterministic engine treats this as fatigue-driven decay that needs replacement, not more budget.";
  }
  if (primaryAction === "block_deploy") {
    if (deployment.compatibility.status === "blocked" && lifecycleState !== "blocked" && lifecycleState !== "retired") {
      return "Deterministic engine blocks deployment because no compatible live lane is currently available for this family.";
    }
    return lifecycleState === "retired"
      ? "Deterministic engine keeps this inactive until it earns a comeback case."
      : "Deterministic engine blocks deployment because downside risk outweighs current upside.";
  }
  if (primaryAction === "retest_comeback") {
    return "Deterministic engine sees prior winner memory and recommends a bounded comeback retest.";
  }
  if (economics.status === "guarded") {
    return "Deterministic engine keeps this in test because relative strength exists, but absolute scaling floors are not proven yet.";
  }
  if (fatigue.status === "watch") {
    return "Deterministic engine keeps this in test while monitoring early fatigue pressure.";
  }
  return `Deterministic engine keeps this in test against the ${benchmark.selectedCohortLabel.toLowerCase()} benchmark.`;
}

function buildReasons(
  benchmark: CreativeDecisionBenchmark,
  fatigue: CreativeDecisionFatigue,
  economics: CreativeDecisionEconomics,
  deployment: CreativeDecisionDeploymentRecommendation,
) {
  const reasons = [
    `ROAS benchmark status is ${benchmark.metrics.roas.status}.`,
    `Click-to-purchase benchmark status is ${benchmark.metrics.clickToPurchase.status}.`,
    `Selected cohort is ${benchmark.selectedCohortLabel}.`,
  ];
  if (economics.reasons[0]) reasons.push(economics.reasons[0]);
  if (fatigue.evidence[0]) reasons.push(fatigue.evidence[0]);
  if (deployment.compatibility.reasons[0]) reasons.push(deployment.compatibility.reasons[0]);
  if (deployment.constraints[0]) reasons.push(deployment.constraints[0]);
  return reasons.slice(0, 4);
}

const CREATIVE_ACTION_AGGRESSION_RANK: Record<CreativeDecisionPrimaryAction, number> = {
  block_deploy: 0,
  hold_no_touch: 1,
  refresh_replace: 1,
  keep_in_test: 2,
  retest_comeback: 2,
  promote_to_scaling: 4,
};

function isConservativeCreativePolicyCutover(
  baselineAction: CreativeDecisionPrimaryAction,
  candidateAction: CreativeDecisionPrimaryAction,
) {
  return (
    CREATIVE_ACTION_AGGRESSION_RANK[candidateAction] <=
    CREATIVE_ACTION_AGGRESSION_RANK[baselineAction]
  );
}

function resolveCreativePolicyDriver(input: {
  primaryAction: CreativeDecisionPrimaryAction;
  operatingMode: AccountOperatingModePayload | null | undefined;
  deployment: CreativeDecisionDeploymentRecommendation;
  fatigue: CreativeDecisionFatigue;
  lifecycleState: CreativeDecisionLifecycleState;
}): CreativeDecisionPolicyDriver {
  if (input.operatingMode?.degradedMode.active) return "commercial_truth";
  if (input.primaryAction === "hold_no_touch") return "protected_winner";
  if (input.lifecycleState === "comeback_candidate" || input.primaryAction === "retest_comeback") {
    return "comeback";
  }
  if (input.fatigue.status === "fatigued" || input.primaryAction === "refresh_replace") {
    return "fatigue";
  }
  if (
    input.deployment.compatibility.status === "blocked" ||
    input.deployment.compatibility.status === "limited"
  ) {
    return "deployment_match";
  }
  if (input.primaryAction === "promote_to_scaling") return "economics";
  return "test_validation";
}

function buildCreativePolicyEnvelope(input: {
  lifecycleState: CreativeDecisionLifecycleState;
  baselinePrimaryAction: CreativeDecisionPrimaryAction;
  fatigue: CreativeDecisionFatigue;
  economics: CreativeDecisionEconomics;
  deployment: CreativeDecisionDeploymentRecommendation;
  operatingMode: AccountOperatingModePayload | null | undefined;
  metaFamily: MetaCampaignFamily;
  metaFamilyLabel: string;
  familyRowCount: number;
  familyAngleDepth: number;
}) {
  const objectiveFamily =
    normalizeText(input.deployment.compatibility.objectiveFamily).replaceAll("_", " ") ||
    "unknown";
  const bidRegime =
    normalizeText(input.deployment.compatibility.bidRegime).replaceAll("_", " ") || "unknown";
  const objectiveBlocked =
    input.baselinePrimaryAction === "promote_to_scaling" &&
    (objectiveFamily.includes("awareness") || objectiveFamily.includes("traffic"));
  const objectiveWatch =
    input.baselinePrimaryAction === "promote_to_scaling" &&
    !objectiveBlocked &&
    (objectiveFamily.includes("lead") || objectiveFamily.includes("engagement"));
  const objectiveFloor = buildObjectiveFamilyPolicyFloor({
    current: objectiveFamily,
    required:
      input.baselinePrimaryAction === "promote_to_scaling"
        ? "lower-funnel objective family for scale deployment"
        : "policy-compatible objective",
    status: objectiveBlocked ? "blocked" : objectiveWatch ? "watch" : "met",
    reason: objectiveBlocked
      ? "Upper-funnel objectives stay on test or broaden ladders instead of moving straight into scaling."
      : objectiveWatch
        ? "Lead and engagement families need stronger proof before full scale promotion."
        : null,
  });
  const bidFloor = buildBidRegimePolicyFloor({
    current: bidRegime,
    required:
      input.baselinePrimaryAction === "promote_to_scaling"
        ? "open or comfortably proven constrained bidding"
        : "bid regime aligned with the next move",
    status:
      input.baselinePrimaryAction !== "promote_to_scaling"
        ? "met"
        : bidRegime === "bid_cap" || bidRegime === "roas_floor"
          ? "blocked"
          : bidRegime === "cost_cap"
            ? "watch"
            : "met",
    reason:
      input.baselinePrimaryAction !== "promote_to_scaling"
        ? null
        : bidRegime === "bid_cap" || bidRegime === "roas_floor"
          ? "The current bid regime is too restrictive for a compare-safe scale promotion."
          : bidRegime === "cost_cap"
            ? "Cost-cap delivery can scale, but only while the cap still leaves clean headroom."
            : null,
  });
  const campaignFamilyFloor = buildCampaignFamilyPolicyFloor({
    current: input.metaFamilyLabel,
    required:
      input.baselinePrimaryAction === "promote_to_scaling"
        ? "purchase, mid-funnel, or lead family"
        : "family aligned with the current operator lane",
    status:
      input.baselinePrimaryAction !== "promote_to_scaling"
        ? "met"
        : input.metaFamily === "awareness" || input.metaFamily === "engagement"
          ? "watch"
          : "met",
    reason:
      input.baselinePrimaryAction === "promote_to_scaling" &&
      (input.metaFamily === "awareness" || input.metaFamily === "engagement")
        ? "Awareness and engagement families stay on softer deployment ladders until direct-response proof improves."
        : null,
  });
  const deploymentFloor = buildDeploymentCompatibilityPolicyFloor({
    current: input.deployment.compatibility.status,
    required: "compatible live lane",
    status:
      input.deployment.compatibility.status === "compatible"
        ? "met"
        : input.deployment.compatibility.status === "limited"
          ? "watch"
          : "blocked",
    reason:
      input.deployment.compatibility.reasons[0] ??
      (input.deployment.compatibility.status === "compatible"
        ? null
        : "No compatible live lane is ready for this creative."),
  });

  let candidateAction = input.baselinePrimaryAction;
  let candidateReason =
    "Shared policy ladder matched the baseline creative decision.";
  let actionCeiling: string | null = null;

  if (input.operatingMode?.degradedMode.active && input.baselinePrimaryAction === "promote_to_scaling") {
    candidateAction = "keep_in_test";
    candidateReason =
      "Shared policy ladder keeps this in test because commercial truth is degraded.";
    actionCeiling = "No scale promotion until degraded commercial truth is restored.";
  } else if (
    input.lifecycleState === "stable_winner" ||
    input.baselinePrimaryAction === "hold_no_touch"
  ) {
    candidateAction = "hold_no_touch";
    candidateReason =
      "Shared policy ladder preserves the protected winner path for this creative.";
    actionCeiling = "Protected winner only while performance remains stable.";
  } else if (input.lifecycleState === "comeback_candidate") {
    candidateAction = "retest_comeback";
    candidateReason =
      "Shared policy ladder keeps comeback memory on a bounded refresh path.";
    actionCeiling = "Refresh comeback only; keep comeback volume bounded until the next winner proof appears.";
  } else if (input.fatigue.status === "fatigued") {
    candidateAction = "refresh_replace";
    candidateReason =
      "Shared policy ladder routes this creative into refresh before any broader redeploy.";
    actionCeiling = "Refresh only until fatigue pressure clears.";
  } else if (input.baselinePrimaryAction === "promote_to_scaling") {
    if (
      deploymentFloor.status === "blocked" ||
      objectiveFloor.status === "blocked" ||
      bidFloor.status === "blocked"
    ) {
      candidateAction = "block_deploy";
      candidateReason =
        "Shared policy ladder blocks live promotion because a required scale floor is still blocked.";
      actionCeiling = "Do not deploy into scaling until the blocked floor is cleared.";
    } else if (
      deploymentFloor.status === "watch" ||
      objectiveFloor.status === "watch" ||
      bidFloor.status === "watch" ||
      campaignFamilyFloor.status === "watch"
    ) {
      candidateAction = "keep_in_test";
      candidateReason =
        "Shared policy ladder keeps this in test because one or more scale floors are still on watch.";
      actionCeiling = "Test-only until deployment, family, and bid alignment all move out of watch state.";
    }
  }

  const compare = buildDecisionPolicyCompare({
    baselineAction: input.baselinePrimaryAction,
    candidateAction,
    allowCandidate: isConservativeCreativePolicyCutover(
      input.baselinePrimaryAction,
      candidateAction,
    ),
    candidateReason,
    baselineReason:
      "Shared policy ladder stayed in compare mode because the candidate branch was not safer than the current baseline.",
  });

  const primaryAction =
    compare.selectedAction === input.baselinePrimaryAction
      ? input.baselinePrimaryAction
      : candidateAction;
  const primaryDriver = resolveCreativePolicyDriver({
    primaryAction,
    operatingMode: input.operatingMode,
    deployment: input.deployment,
    fatigue: input.fatigue,
    lifecycleState: input.lifecycleState,
  });

  return {
    primaryAction,
    policy: {
      primaryDriver,
      objectiveFamily:
        input.deployment.compatibility.objectiveFamily ?? null,
      bidRegime: input.deployment.compatibility.bidRegime ?? null,
      metaFamily: input.metaFamily,
      deploymentCompatibility: input.deployment.compatibility.status,
      explanation: compileDecisionPolicyExplanation({
        summary:
          compare.selectedAction === input.baselinePrimaryAction
            ? `Shared policy ladder kept ${input.baselinePrimaryAction.replaceAll("_", " ")} active for this creative.`
            : `Shared policy ladder promoted ${candidateAction.replaceAll("_", " ")} as the active creative branch.`,
        axes: [
          objectiveFloor,
          bidFloor,
          campaignFamilyFloor,
          deploymentFloor,
        ],
        degradedReasons: input.operatingMode?.degradedMode.active
          ? input.operatingMode?.degradedMode.reasons
          : [],
        actionCeiling,
        protectedWinnerHandling:
          primaryAction === "hold_no_touch"
            ? "Protected winners stay out of the promotion queue and remain visible as guardrail context."
            : null,
        fatigueOrComeback:
          input.fatigue.status === "fatigued"
            ? "Fatigue logic outranks deployment expansion until a refreshed concept exists."
            : input.lifecycleState === "comeback_candidate"
              ? "Comeback logic stays bounded and never jumps straight into scale."
              : null,
        supplyPlanning:
          primaryAction === "refresh_replace"
            ? "Supply planning should refresh the current winner family before reopening scale."
            : primaryAction === "promote_to_scaling" &&
                input.familyRowCount <= 2 &&
                input.familyAngleDepth <= 1
              ? "Supply planning should expand adjacent angles before saturation shows up."
              : primaryAction === "retest_comeback"
                ? "Supply planning should keep comeback retries isolated from the live winner pool."
                : null,
        compare,
      }),
    },
  };
}

function buildLifecycleBoard(creatives: CreativeDecisionOsCreative[]) {
  const orderedStates: CreativeDecisionLifecycleState[] = [
    "incubating",
    "validating",
    "scale_ready",
    "stable_winner",
    "fatigued_winner",
    "blocked",
    "retired",
    "comeback_candidate",
  ];
  return orderedStates.map((state) => ({
    state,
    label: state.replaceAll("_", " "),
    count: creatives.filter((creative) => creative.lifecycleState === state).length,
    creativeIds: creatives
      .filter((creative) => creative.lifecycleState === state)
      .map((creative) => creative.creativeId),
  }));
}

function buildOperatorQueues(creatives: CreativeDecisionOsCreative[]) {
  const queueSourceCreatives = creatives.filter(
    (creative) =>
      creative.operatorPolicy.state !== "contextual_only" &&
      creative.operatorPolicy.state !== "blocked",
  );
  const definitions = [
    {
      key: "promotion" as const,
      label: "Queue-ready",
      summary: "Scale creatives with compatible deployment lanes.",
      match: (creative: CreativeDecisionOsCreative) =>
        creative.operatorPolicy.segment === "scale_ready",
    },
    {
      key: "keep_testing" as const,
      label: "Board-only / Test More",
      summary: "Incubating and validating creatives that stay visible but out of the default queue.",
      match: (creative: CreativeDecisionOsCreative) => creative.primaryAction === "keep_in_test",
    },
    {
      key: "fatigued_blocked" as const,
      label: "Refresh / Cut",
      summary: "Creatives that should be refreshed or held out of deployment.",
      match: (creative: CreativeDecisionOsCreative) =>
        creative.operatorPolicy.segment === "fatigued_winner" ||
        creative.operatorPolicy.segment === "kill_candidate" ||
        creative.operatorPolicy.segment === "spend_waste",
    },
    {
      key: "comeback" as const,
      label: "Board-only / comeback",
      summary: "Former winners worth a tightly-bounded comeback refresh, not default queue work.",
      match: (creative: CreativeDecisionOsCreative) => creative.primaryAction === "retest_comeback",
    },
  ];

  return definitions.map((definition) => {
    const matched = queueSourceCreatives.filter(definition.match);
    return {
      key: definition.key,
      label: definition.label,
      summary: definition.summary,
      count: matched.length,
      creativeIds: matched.map((creative) => creative.creativeId),
    } satisfies CreativeDecisionOperatorQueue;
  });
}

function buildProtectedWinners(creatives: CreativeDecisionOsCreative[]) {
  return creatives
    .filter(
      (creative) =>
        creative.primaryAction === "hold_no_touch" ||
        creative.lifecycleState === "stable_winner",
    )
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 8)
    .map((creative) => ({
      creativeId: creative.creativeId,
      familyId: creative.familyId,
      creativeName: creative.name,
      familyLabel: creative.familyLabel,
      spend: round(creative.spend, 2),
      roas: round(creative.roas, 2),
      reasons: [
        creative.summary,
        creative.fatigue.status !== "none"
          ? `Fatigue status: ${creative.fatigue.status}.`
          : "Winner remains protected outside the action-core promotion queue.",
      ].slice(0, 3),
    })) satisfies CreativeDecisionProtectedWinner[];
}

function buildSupplyPlan(
  creatives: CreativeDecisionOsCreative[],
  families: CreativeDecisionOsFamily[],
) {
  const items: CreativeDecisionSupplyPlanItem[] = [];

  for (const family of families) {
    const familyCreatives = creatives.filter((creative) => creative.familyId === family.familyId);
    const hasComeback = familyCreatives.some((creative) => creative.primaryAction === "retest_comeback");
    const hasProtectedWinner = familyCreatives.some((creative) => creative.primaryAction === "hold_no_touch");
    const hasScaleCandidate = familyCreatives.some((creative) => creative.primaryAction === "promote_to_scaling");
    const hasFatigue = familyCreatives.some(
      (creative) =>
        creative.primaryAction === "refresh_replace" ||
        creative.fatigue.status === "watch" ||
        creative.fatigue.status === "fatigued",
    );

    if (hasFatigue && family.totalSpend >= 150) {
      items.push({
        kind: "refresh_existing_winner",
        priority: family.lifecycleState === "fatigued_winner" ? "high" : "medium",
        familyId: family.familyId,
        familyLabel: family.familyLabel,
        creativeIds: family.creativeIds,
        summary: "Refresh the dominant winner before fatigue decay spills into the next live window.",
        reasons: [
          ...familyCreatives.flatMap((creative) => creative.fatigue.evidence.slice(0, 1)),
          "Family shows winner memory with active fatigue pressure.",
        ].slice(0, 3),
      });
    }

    if (hasScaleCandidate && family.topAngles.length <= 1 && family.creativeIds.length <= 2) {
      items.push({
        kind: "expand_angle_family",
        priority: "medium",
        familyId: family.familyId,
        familyLabel: family.familyLabel,
        creativeIds: family.creativeIds,
        summary: "Expand this winner family with adjacent angle variants before saturation shows up.",
        reasons: [
          "Family is scale-capable but creative depth is still shallow.",
          `Current angle depth: ${family.topAngles.length}.`,
        ].slice(0, 3),
      });
    }

    if (!hasProtectedWinner && !hasComeback && family.primaryAction === "keep_in_test" && family.totalSpend >= 150) {
      items.push({
        kind: "new_test_concepts",
        priority: family.totalSpend >= 300 ? "high" : "medium",
        familyId: family.familyId,
        familyLabel: family.familyLabel,
        creativeIds: family.creativeIds,
        summary: "Generate fresh test concepts to widen hook and angle coverage for this family.",
        reasons: [
          "Family has meaningful spend but no protected winner yet.",
          `Observed hooks: ${family.topHooks.join(", ") || "limited"}.`,
        ].slice(0, 3),
      });
    }

    if (hasComeback) {
      items.push({
        kind: "revive_comeback",
        priority: "low",
        familyId: family.familyId,
        familyLabel: family.familyLabel,
        creativeIds: family.creativeIds,
        summary: "Refresh the historical winner with bounded volume before committing broader spend.",
        reasons: [
          "Historical winner memory exists for this family.",
          "Comeback candidates should stay tightly scoped and retry-safe.",
        ],
      });
    }
  }

  const priorityRank: Record<CreativeDecisionSupplyPlanPriority, number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  return items
    .sort((left, right) => priorityRank[right.priority] - priorityRank[left.priority])
    .slice(0, 10);
}

function buildCreativeOpportunityTrust(input: {
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

function buildCreativeOpportunityBoard(input: {
  creatives: CreativeDecisionOsCreative[];
  families: CreativeDecisionOsFamily[];
  protectedWinners: CreativeDecisionProtectedWinner[];
}) {
  const items: CreativeOpportunityBoardItem[] = [];
  const creativesById = new Map(
    input.creatives.map((creative) => [creative.creativeId, creative]),
  );

  for (const family of input.families) {
    const familyCreatives = input.creatives.filter(
      (creative) => creative.familyId === family.familyId,
    );
    const bestPromotionCreative = familyCreatives
      .filter((creative) => creative.operatorPolicy.segment === "scale_ready")
      .sort((left, right) => right.confidence - left.confidence)[0];
    if (!bestPromotionCreative) continue;
    const baseTrust = bestPromotionCreative.trust;
    const evidenceFloors = [
      buildDecisionEvidenceFloor({
        key: "scale_readiness",
        label: "Scale readiness",
        current: `${familyCreatives.filter((creative) => creative.primaryAction === "promote_to_scaling").length} promotable creative`,
        required: "1+ promotable creative",
        met: familyCreatives.some(
          (creative) => creative.primaryAction === "promote_to_scaling",
        ),
      }),
      buildDecisionEvidenceFloor({
        key: "signal_depth",
        label: "Signal depth",
        current: `$${Math.round(family.totalSpend)} / ${family.totalPurchases} purchases`,
        required: "$150 spend and 4 purchases",
        status:
          family.totalSpend >= 150 && family.totalPurchases >= 4
            ? "met"
            : family.totalSpend >= 80 || family.totalPurchases >= 2
              ? "watch"
              : "blocked",
        reason:
          family.totalSpend >= 150 && family.totalPurchases >= 4
            ? null
            : "Creative family needs more spend and purchase depth before queue intake.",
      }),
      buildDecisionEvidenceFloor({
        key: "deployment_match",
        label: "Deployment match",
        current: bestPromotionCreative.deployment.compatibility.status,
        required: "compatible lane",
        status:
          bestPromotionCreative.deployment.compatibility.status === "compatible"
            ? "met"
            : bestPromotionCreative.deployment.compatibility.status === "limited"
              ? "watch"
              : "blocked",
        reason:
          bestPromotionCreative.deployment.compatibility.reasons[0] ??
          "No compatible live deployment lane is ready for this family.",
      }),
      buildDecisionEvidenceFloor({
        key: "commercial_truth",
        label: "Commercial truth",
        current: baseTrust.truthState.replaceAll("_", " "),
        required: "live confident",
        met: baseTrust.truthState === "live_confident",
        reason:
          "Shared authority still caps this family out of the default queue.",
      }),
      buildDecisionEvidenceFloor({
        key: "creative_operator_policy",
        label: "Creative operator policy",
        current: bestPromotionCreative.operatorPolicy.pushReadiness.replaceAll("_", " "),
        required: "safe to queue",
        met: bestPromotionCreative.operatorPolicy.pushReadiness === "safe_to_queue",
        reason:
          bestPromotionCreative.operatorPolicy.pushReadiness === "safe_to_queue"
            ? null
            : bestPromotionCreative.operatorPolicy.explanation,
      }),
    ];
    const queue = evaluateDecisionOpportunityQueue({
      truthState: baseTrust.truthState,
      authorityReady: baseTrust.surfaceLane === "action_core",
      floors: evidenceFloors,
      blockedReasons:
        baseTrust.truthState === "degraded_missing_truth"
          ? baseTrust.reasons
          : [],
    });
    items.push({
      opportunityId: `creative-family-scale:${family.familyId}`,
      kind: "creative_family_winner_scale",
      title: family.familyLabel,
      summary:
        bestPromotionCreative.summary ??
        "This creative family has a deterministic scale-ready path.",
      recommendedAction: "promote_to_scaling",
      confidence: clamp(
        average(
          familyCreatives
            .filter((creative) => creative.primaryAction === "promote_to_scaling")
            .map((creative) => creative.confidence),
        ),
        0.3,
        0.92,
      ),
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: ["scale_promotions"],
      trust: buildCreativeOpportunityTrust({
        baseTrust,
        reasons: [bestPromotionCreative.summary],
      }),
      familyId: family.familyId,
      creativeIds: family.creativeIds,
    });
  }

  for (const protectedWinner of input.protectedWinners) {
    const baseCreative =
      creativesById.get(protectedWinner.creativeId) ??
      input.creatives.find((creative) => creative.familyId === protectedWinner.familyId) ??
      null;
    const baseTrust =
      baseCreative?.trust ??
      compileDecisionTrust({
        surfaceLane: "watchlist",
        truthState: "live_confident",
        operatorDisposition: "protected_watchlist",
        reasons: protectedWinner.reasons,
      });
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
        reason:
          "Protected winners stay visible for operator context, not as queue work.",
      }),
    ];
    const queue = evaluateDecisionOpportunityQueue({
      truthState: baseTrust.truthState,
      authorityReady: false,
      floors: evidenceFloors,
    });
    items.push({
      opportunityId: `creative-protected:${protectedWinner.creativeId}`,
      kind: "protected_winner",
      title: protectedWinner.creativeName,
      summary: protectedWinner.reasons[0] ?? "Protected creative winner.",
      recommendedAction: "hold_no_touch",
      confidence: baseCreative?.confidence ?? 0.72,
      queue,
      eligibilityTrace: queue.eligibilityTrace,
      evidenceFloors,
      tags: ["promo_mode_watchlist"],
      trust: buildCreativeOpportunityTrust({
        baseTrust,
        reasons: protectedWinner.reasons,
      }),
      familyId: protectedWinner.familyId,
      creativeIds: [protectedWinner.creativeId],
    });
  }

  return items.sort(
    (left, right) =>
      Number(right.queue.eligible) - Number(left.queue.eligible) ||
      right.confidence - left.confidence ||
      left.title.localeCompare(right.title),
  );
}

function buildCreativeActionProvenance(input: {
  businessId: string;
  decisionAsOf: string;
  analyticsWindow: OperatorAnalyticsWindow;
  reportingRange: {
    startDate: string;
    endDate: string;
  };
  sourceWindow: OperatorDecisionWindows["primary30d"];
  creativeId: string;
  familyId: string;
  familySource: CreativeDecisionFamilySource;
  primaryAction: CreativeDecisionPrimaryAction;
  lifecycleState: CreativeDecisionLifecycleState;
  legacyAction: CreativeDecisionAction;
  score: number;
  confidence: number;
  benchmark: CreativeDecisionBenchmark;
  fatigue: CreativeDecisionFatigue;
  economics: CreativeDecisionEconomics;
  deployment: CreativeDecisionDeploymentRecommendation;
  trust: DecisionTrustMetadata;
}) {
  return buildOperatorDecisionProvenance({
    businessId: input.businessId,
    decisionAsOf: input.decisionAsOf,
    analyticsWindow: input.analyticsWindow,
    reportingRange: input.reportingRange,
    sourceWindow: input.sourceWindow,
    sourceRowScope: {
      system: "creative",
      entityType: "creative",
      entityId: input.creativeId,
    },
    sourceDecisionId: `creative:${input.creativeId}`,
    recommendedAction: input.primaryAction,
    evidence: {
      creativeId: input.creativeId,
      familyId: input.familyId,
      familySource: input.familySource,
      lifecycleState: input.lifecycleState,
      primaryAction: input.primaryAction,
      legacyAction: input.legacyAction,
      score: input.score,
      confidence: input.confidence,
      benchmark: {
        selectedCohort: input.benchmark.selectedCohort,
        sampleSize: input.benchmark.sampleSize,
        roasStatus: input.benchmark.metrics.roas.status,
        cpaStatus: input.benchmark.metrics.cpa.status,
        ctrStatus: input.benchmark.metrics.ctr.status,
        clickToPurchaseStatus: input.benchmark.metrics.clickToPurchase.status,
      },
      fatigue: {
        status: input.fatigue.status,
        confidence: input.fatigue.confidence,
      },
      economics: {
        status: input.economics.status,
        absoluteSpendFloor: input.economics.absoluteSpendFloor,
        absolutePurchaseFloor: input.economics.absolutePurchaseFloor,
        roasFloor: input.economics.roasFloor,
        cpaCeiling: input.economics.cpaCeiling,
      },
      deployment: {
        status: input.deployment.compatibility.status,
        targetLane: input.deployment.targetLane,
        targetAdSetRole: input.deployment.targetAdSetRole,
        queueVerdict: input.deployment.queueVerdict,
        geoContext: input.deployment.geoContext,
      },
      trust: {
        surfaceLane: input.trust.surfaceLane,
        truthState: input.trust.truthState,
        operatorDisposition: input.trust.operatorDisposition,
        entityState: input.trust.evidence?.entityState ?? null,
        materiality: input.trust.evidence?.materiality ?? null,
      },
    },
  });
}

export function buildCreativeDecisionOs(
  input: BuildCreativeDecisionOsInput,
): CreativeDecisionOsV1Response {
  const builtDecisionMetadata = buildOperatorDecisionMetadata({
    analyticsStartDate: input.startDate,
    analyticsEndDate: input.endDate,
    decisionAsOf: input.decisionAsOf ?? input.endDate,
  });
  const decisionMetadata = {
    analyticsWindow: input.analyticsWindow ?? builtDecisionMetadata.analyticsWindow,
    decisionWindows: input.decisionWindows ?? builtDecisionMetadata.decisionWindows,
    historicalMemory: input.historicalMemory ?? builtDecisionMetadata.historicalMemory,
    decisionAsOf: input.decisionAsOf ?? builtDecisionMetadata.decisionAsOf,
  };
  const rows = input.rows
    .map((row) => ({
      ...row,
      creativeFormat: row.creativeFormat ?? "image",
      aiTags: row.aiTags ?? {},
      copyVariants: row.copyVariants ?? [],
      headlineVariants: row.headlineVariants ?? [],
      descriptionVariants: row.descriptionVariants ?? [],
      historicalWindows: row.historicalWindows ?? null,
    }))
    .filter((row) => row.creativeId);

  if (rows.length === 0) {
    const emptyBenchmarkScope = resolveBenchmarkScopeMetadata(input, []);
    const commercialTruthCoverage = buildCommercialTruthCoverage(
      input.commercialTruth,
      input.operatingMode,
    );
    const emptySourceHealth = [
      {
        source: "Creative source",
        status: "degraded" as const,
        detail: "No creative rows were available for the current decision window.",
        fallbackLabel: "empty fallback",
      },
      {
        source: "Commercial truth",
        status:
          commercialTruthCoverage.summary?.freshness.status === "fresh"
            ? ("healthy" as const)
            : commercialTruthCoverage.summary?.freshness.status === "stale"
              ? ("stale" as const)
              : ("degraded" as const),
        detail:
          commercialTruthCoverage.summary?.freshness.reason ??
          "Commercial truth is configured for creative decisioning.",
        fallbackLabel:
          commercialTruthCoverage.summary?.freshness.status === "fresh"
            ? null
            : "shared trust ceiling",
      },
    ];
    const emptyReadReliability = {
      status: "degraded" as const,
      determinism: "unstable" as const,
      detail:
        "The creative surface is in degraded mode because no rows were available for the current decision window.",
    };
    const authority = buildDecisionSurfaceAuthority({
      scope: "Creative Decision OS",
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
      freshness: input.operatingMode?.authority?.freshness ?? buildDecisionFreshness(),
      missingInputs: commercialTruthCoverage.missingInputs,
      reasons: commercialTruthCoverage.guardrails,
      actionCoreCount: 0,
      watchlistCount: 0,
      archiveCount: 0,
      suppressedCount: 0,
      note:
        commercialTruthCoverage.missingInputs.length > 0
          ? "Creative Decision OS has no live rows and remains trust-capped by incomplete commercial truth."
          : "Creative Decision OS has no live rows in the current decision window.",
      readiness: {
        daysReady: 0,
        daysExpected: 30,
        missingInputs: commercialTruthCoverage.missingInputs,
        suppressedActionClasses: commercialTruthCoverage.summary?.actionCeilings ?? [],
        previewCoverage: {
          readyCount: 0,
          degradedCount: 0,
          missingCount: 0,
        },
      },
      sourceHealth: emptySourceHealth,
      readReliability: emptyReadReliability,
    });

    return {
      contractVersion: CREATIVE_DECISION_OS_CONTRACT_VERSION,
      engineVersion: CREATIVE_DECISION_OS_ENGINE_VERSION,
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      analyticsWindow: decisionMetadata.analyticsWindow,
      decisionWindows: decisionMetadata.decisionWindows,
      historicalMemory: decisionMetadata.historicalMemory,
      decisionAsOf: decisionMetadata.decisionAsOf,
      summary: {
        totalCreatives: 0,
        scaleReadyCount: 0,
        keepTestingCount: 0,
        fatiguedCount: 0,
        blockedCount: 0,
        comebackCount: 0,
        protectedWinnerCount: 0,
        supplyPlanCount: 0,
        opportunitySummary: {
          totalCount: 0,
          queueEligibleCount: 0,
          protectedCount: 0,
          familyScaleCount: 0,
          headline: "No opportunity-board item is available yet.",
        },
        benchmarkScope: emptyBenchmarkScope,
        message: "No creative rows were available for the live decision window.",
        operatingMode: input.operatingMode?.recommendedMode ?? null,
        sourceHealth: emptySourceHealth,
        readReliability: emptyReadReliability,
        surfaceSummary: {
          actionCoreCount: 0,
          watchlistCount: 0,
          archiveCount: 0,
          degradedCount: 0,
          profitableTruthCappedCount: 0,
        },
        readiness: {
          daysReady: 0,
          daysExpected: 30,
          missingInputs: commercialTruthCoverage.missingInputs,
          suppressedActionClasses: commercialTruthCoverage.summary?.actionCeilings ?? [],
          previewCoverage: {
            readyCount: 0,
            degradedCount: 0,
            missingCount: 0,
          },
        },
      },
      creatives: [],
      families: [],
      patterns: [],
      protectedWinners: [],
      supplyPlan: [],
      opportunityBoard: [],
      lifecycleBoard: buildLifecycleBoard([]),
      operatorQueues: buildOperatorQueues([]),
      commercialTruthCoverage,
      historicalAnalysis: buildEmptyCreativeHistoricalAnalysis({
        startDate: input.startDate,
        endDate: input.endDate,
        summary:
          "No selected-period creative evidence was available. This block stays descriptive and does not change deterministic Decision Signals.",
      }),
      authority,
    };
  }

  const campaignsById = new Map((input.campaigns ?? []).map((campaign) => [campaign.id, campaign]));
  const locationRows = input.breakdowns?.location ?? [];
  const familySeeds = buildCreativeFamilySeeds(rows);
  const metricContext = buildMetricContext(rows);
  const benchmarkScopeMetadata = resolveBenchmarkScopeMetadata(input, rows);
  const familyRowsById = new Map<string, CreativeDecisionOsInputRow[]>();

  for (const row of rows) {
    const seed = familySeeds.get(row.creativeId)!;
    familyRowsById.set(seed.familyId, [...(familyRowsById.get(seed.familyId) ?? []), row]);
  }

  const commercialTruthCoverage = buildCommercialTruthCoverage(
    input.commercialTruth,
    input.operatingMode,
  );
  const evidenceSource = input.evidenceSource ?? "unknown";

  const creatives: CreativeDecisionOsCreative[] = rows.map((row) => {
    const familySeed = familySeeds.get(row.creativeId)!;
    const familyRows = familyRowsById.get(familySeed.familyId) ?? [row];
    const familyProvenance = buildFamilyProvenance(familySeed, familyRows);
    const metaFamily = metaFamilyFromRow(row, campaignsById);
    const benchmark = selectBenchmark(row, familyRows, rows, metaFamily);
    const relativeBaseline = buildRelativeBaseline({
      row,
      rows,
      scopeMetadata: benchmarkScopeMetadata,
    });
    const fatigue = buildFatigue(row, familyRows, benchmark);
    const historical = buildHistoricalSummary(row);
    const lifecycleState = classifyLifecycle({
      row,
      benchmark,
      fatigue,
      historical,
      operatingMode: input.operatingMode,
    });
    const basePrimaryAction = decidePrimaryAction(lifecycleState, input.operatingMode);
    const economics = buildEconomics(row, input.commercialTruth);
    const preliminaryDeployment = buildDeployment(row, {
      campaignsById,
      campaigns: input.campaigns ?? [],
      adSets: input.adSets ?? [],
      locationRows,
      operatingMode: input.operatingMode,
      primaryAction: basePrimaryAction,
      lifecycleState,
      metaFamily,
      confidence: 0.64,
    });
    const primaryAction = resolvePrimaryAction({
      lifecycleState,
      baseAction: basePrimaryAction,
      economics,
      operatingMode: input.operatingMode,
      deployment: preliminaryDeployment,
    });
    const policyEnvelope = buildCreativePolicyEnvelope({
      lifecycleState,
      baselinePrimaryAction: primaryAction,
      fatigue,
      economics,
      deployment: preliminaryDeployment,
      operatingMode: input.operatingMode,
      metaFamily,
      metaFamilyLabel: metaCampaignFamilyLabel(metaFamily),
      familyRowCount: familyRows.length,
      familyAngleDepth: new Set(
        familyRows.map(
          (entry) => entry.aiTags?.messagingAngle?.[0] ?? entry.taxonomySecondaryLabel ?? "unlabeled",
        ),
      ).size,
    });
    const resolvedPrimaryAction = policyEnvelope.primaryAction;
    const score = buildScore(row, benchmark, fatigue, lifecycleState);
    const confidence = buildConfidence(row, benchmark, fatigue, input.operatingMode);
    const legacyAction = legacyActionFromPrimary({
      primaryAction: resolvedPrimaryAction,
      lifecycleState,
      score,
      confidence,
    });
    const legacyLifecycleState = legacyLifecycleFromState(lifecycleState, legacyAction);
    const commercialTruthConfigured =
      commercialTruthCoverage.configuredSections.targetPack;
    const relativeScaleReviewCandidate =
      !commercialTruthConfigured &&
      lifecycleState === "scale_ready" &&
      (relativeBaseline.reliability === "strong" ||
        relativeBaseline.reliability === "medium");
    const deployment = buildDeployment(row, {
      campaignsById,
      campaigns: input.campaigns ?? [],
      adSets: input.adSets ?? [],
      locationRows,
      operatingMode: input.operatingMode,
      primaryAction: relativeScaleReviewCandidate
        ? "promote_to_scaling"
        : resolvedPrimaryAction,
      lifecycleState,
      metaFamily,
      confidence,
    });
    const pattern = buildPattern(row);
    const previewStatus = buildPreviewStatus(row);
    const deliveryContext = buildCreativeDeliveryContext(row, {
      campaignsById,
      adSets: input.adSets ?? [],
    });
    const summary = buildSummary(
      resolvedPrimaryAction,
      lifecycleState,
      benchmark,
      fatigue,
      economics,
      deployment,
    );
    const reasons = buildReasons(benchmark, fatigue, economics, deployment);
    const familyLabel = chooseCreativeFamilyLabel(familyRows);
    const trust = buildCreativeTrust({
      row,
      lifecycleState,
      primaryAction: resolvedPrimaryAction,
      operatingMode: input.operatingMode,
      historical,
      summary,
      deployment,
    });
    const provenance = buildCreativeActionProvenance({
      businessId: input.businessId,
      decisionAsOf: decisionMetadata.decisionAsOf,
      analyticsWindow: decisionMetadata.analyticsWindow,
      reportingRange: {
        startDate: input.startDate,
        endDate: input.endDate,
      },
      sourceWindow: decisionMetadata.decisionWindows.primary30d,
      creativeId: row.creativeId,
      familyId: familySeed.familyId,
      familySource: familySeed.familySource,
      primaryAction: resolvedPrimaryAction,
      lifecycleState,
      legacyAction,
      score,
      confidence,
      benchmark,
      fatigue,
      economics,
      deployment,
      trust,
    });
    const operatorPolicy = assessCreativeOperatorPolicy({
      lifecycleState,
      primaryAction: resolvedPrimaryAction,
      trust,
      provenance,
      evidenceSource,
      commercialTruthConfigured,
      commercialMissingInputs: commercialTruthCoverage.missingInputs,
      relativeBaseline,
      benchmark,
      fatigue,
      economics,
      deployment,
      deliveryContext,
      previewStatus,
      supportingMetrics: {
        spend: row.spend,
        purchases: row.purchases,
        impressions: row.impressions,
        roas: row.roas,
        cpa: row.cpa,
        frequency: row.frequency,
        creativeAgeDays: row.creativeAgeDays,
        recentSpend: row.historicalWindows?.last7?.spend ?? null,
        recentPurchases: row.historicalWindows?.last7?.purchases ?? null,
        recentRoas: row.historicalWindows?.last7?.roas ?? null,
      },
    });
    const benchmarkScopeVerdict = `${relativeBaseline.scopeLabel.toLowerCase()} benchmark (${relativeBaseline.reliability} reliability)`;
    const businessValidationNote =
      !commercialTruthConfigured
        ? "Business validation is still missing, so relative strength stays review-only."
        : economics.status !== "eligible" &&
            operatorPolicy.segment !== "creative_learning_incomplete" &&
            operatorPolicy.segment !== "promising_under_sampled"
          ? "Business validation does not yet support a direct scale promotion."
          : null;
    const baselineQualityNote =
      relativeBaseline.reliability === "weak" || relativeBaseline.reliability === "unavailable"
        ? relativeBaseline.missingContext[0] ??
          `Relative benchmark is ${relativeBaseline.reliability}.`
        : relativeBaseline.reliability === "medium"
          ? "Relative benchmark is medium-confidence, so promotion stays conservative."
          : null;
    const report: CreativeRuleReportPayload = {
      creativeId: row.creativeId,
      creativeName: row.name,
      action: legacyAction,
      lifecycleState: legacyLifecycleState,
      score,
      confidence,
      summary,
      coreVerdict: reasons[0],
      accountContext: {
        roasAvg: round(metricContext.roasAvg, 4),
        cpaAvg: round(metricContext.cpaAvg, 4),
        ctrAvg: round(metricContext.ctrAvg, 4),
        spendMedian: round(metricContext.spendMedian, 4),
        spendP20: round(metricContext.spendP20, 4),
        spendP80: round(metricContext.spendP80, 4),
      },
      timeframeContext: {
        coreVerdict: `Live decision window is ${row.roas.toFixed(2)}x ROAS on ${row.purchases} purchases against the ${benchmarkScopeVerdict}.`,
        selectedRangeOverlay: `Live decision window says ROAS is ${benchmark.metrics.roas.status} and click-to-purchase is ${benchmark.metrics.clickToPurchase.status}.`,
        historicalSupport:
          historical.total > 0
            ? `${historical.strongCount}/${historical.total} historical windows look like winner memory.`
            : "Historical support is limited for this creative.",
        note:
          fatigue.status === "fatigued"
            ? "Fatigue engine sees meaningful decay versus prior winner windows."
            : businessValidationNote ??
              baselineQualityNote ??
              benchmark.missingContext[0] ??
              null,
      },
      factors: [
        {
          label: "ROAS benchmark",
          impact:
            benchmark.metrics.roas.status === "better"
              ? "positive"
              : benchmark.metrics.roas.status === "worse"
                ? "negative"
                : "neutral",
          value: `${row.roas.toFixed(2)}x vs ${benchmark.metrics.roas.benchmark?.toFixed(2) ?? "n/a"}x`,
          reason: reasons[0] ?? "ROAS benchmark comparison is mixed.",
        },
        {
          label: "CPA benchmark",
          impact:
            benchmark.metrics.cpa.status === "better"
              ? "positive"
              : benchmark.metrics.cpa.status === "worse"
                ? "negative"
                : "neutral",
          value: `${row.cpa.toFixed(2)} vs ${benchmark.metrics.cpa.benchmark?.toFixed(2) ?? "n/a"}`,
          reason: `CPA benchmark status is ${benchmark.metrics.cpa.status}.`,
        },
        {
          label: "Fatigue",
          impact:
            fatigue.status === "fatigued"
              ? "negative"
              : fatigue.status === "watch"
                ? "neutral"
                : "positive",
          value: fatigue.status,
          reason: fatigue.evidence[0] ?? "No fatigue evidence was detected.",
        },
        {
          label: "Deployment lane",
          impact: deployment.targetLane === "Scaling" ? "positive" : deployment.targetLane ? "neutral" : "negative",
          value: `${deployment.targetLane ?? "none"} / ${deployment.targetAdSetRole ?? "none"}`,
          reason: deployment.constraints[0] ?? "Deployment lane is based on deterministic Meta alignment.",
        },
      ],
      family: {
        familyId: familySeed.familyId,
        familyLabel,
        familySource: familySeed.familySource,
        memberCount: familyRows.length,
      },
      benchmark,
      fatigue,
      economics,
      deployment,
      deterministicDecision: {
        lifecycleState,
        primaryAction: resolvedPrimaryAction,
        legacyAction,
      },
      commercialContext: {
        operatingMode: input.operatingMode?.recommendedMode ?? null,
        confidence: input.operatingMode?.confidence ?? 0.3,
        missingInputs: input.operatingMode?.missingInputs ?? [],
      },
      pattern,
    };

    return {
      creativeId: row.creativeId,
      provenance,
      evidenceHash: provenance.evidenceHash,
      actionFingerprint: provenance.actionFingerprint,
      evidenceSource,
      operatorPolicy,
      familyId: familySeed.familyId,
      familyLabel,
      familySource: familySeed.familySource,
      name: row.name,
      creativeFormat: row.creativeFormat,
      creativeAgeDays: row.creativeAgeDays,
      spend: row.spend,
      purchaseValue: row.purchaseValue,
      roas: row.roas,
      cpa: row.cpa,
      ctr: row.ctr,
      purchases: row.purchases,
      impressions: row.impressions,
      linkClicks: row.linkClicks,
      score,
      confidence,
      lifecycleState,
      primaryAction: resolvedPrimaryAction,
      legacyAction,
      legacyLifecycleState,
      decisionSignals: buildSignals({
        lifecycleState,
        primaryAction: resolvedPrimaryAction,
        benchmark,
        fatigue,
        economics,
        deployment,
      }),
      summary,
      relativeBaseline,
      benchmarkScope: relativeBaseline.scope,
      benchmarkScopeLabel: relativeBaseline.scopeLabel,
      benchmarkSource: relativeBaseline.source,
      benchmarkReliability: relativeBaseline.reliability,
      benchmark,
      fatigue,
      economics,
      policy: policyEnvelope.policy,
      familyProvenance,
      deployment,
      deliveryContext,
      previewStatus,
      pattern,
      report,
      trust,
    };
  });
  const resolvedBenchmarkScopeMetadata: CreativeDecisionBenchmarkScopeMetadata = {
    ...benchmarkScopeMetadata,
    benchmarkReliability: aggregateBenchmarkReliability(
      creatives.map((creative) => creative.relativeBaseline),
    ),
  };

  const families = Array.from(familyRowsById.entries()).map(([familyId, familyRows]) => {
    const creativeEntries = creatives.filter((creative) => creative.familyId === familyId);
    const dominantFormat = creativeEntries[0]?.creativeFormat ?? "image";
    const highestPriority = [...creativeEntries].sort((left, right) => right.score - left.score)[0];
    const familyProvenance =
      highestPriority?.familyProvenance ??
      buildFamilyProvenance(familySeeds.get(familyRows[0]!.creativeId)!, familyRows);
    const topAngles = Array.from(new Set(creativeEntries.map((creative) => creative.pattern.angle))).slice(0, 3);
    const topHooks = Array.from(new Set(creativeEntries.map((creative) => creative.pattern.hook))).slice(0, 3);
    return {
      familyId,
      familyLabel: chooseCreativeFamilyLabel(familyRows),
      familySource: familySeeds.get(familyRows[0]!.creativeId)?.familySource ?? "singleton",
      creativeIds: creativeEntries.map((creative) => creative.creativeId),
      dominantFormat,
      lifecycleState: highestPriority?.lifecycleState ?? "validating",
      primaryAction: highestPriority?.primaryAction ?? "keep_in_test",
      totalSpend: round(sumBy(familyRows, (row) => row.spend), 2),
      totalPurchaseValue: round(sumBy(familyRows, (row) => row.purchaseValue), 2),
      totalPurchases: sumBy(familyRows, (row) => row.purchases),
      topAngles,
      topHooks,
      metaFamily: highestPriority?.deployment.metaFamily ?? "purchase_value",
      metaFamilyLabel: highestPriority?.deployment.metaFamilyLabel ?? metaCampaignFamilyLabel("purchase_value"),
      provenance: familyProvenance,
    } satisfies CreativeDecisionOsFamily;
  });

  const patternMap = new Map<string, CreativeDecisionOsPattern>();
  for (const creative of creatives) {
    const key = `${creative.pattern.hook}__${creative.pattern.angle}__${creative.pattern.format}`;
    const existing = patternMap.get(key);
    if (existing) {
      existing.creativeIds.push(creative.creativeId);
      existing.spend = round(existing.spend + creative.spend, 2);
      existing.purchaseValue = round(existing.purchaseValue + creative.purchaseValue, 2);
      existing.roas = existing.spend > 0 ? round(existing.purchaseValue / existing.spend, 2) : 0;
      existing.confidence = round((existing.confidence + creative.confidence) / 2, 2);
      if (creative.score > existing.confidence * 100) {
        existing.lifecycleState = creative.lifecycleState;
      }
      continue;
    }
    patternMap.set(key, {
      patternKey: key,
      hook: creative.pattern.hook,
      angle: creative.pattern.angle,
      format: creative.pattern.format,
      creativeIds: [creative.creativeId],
      spend: round(creative.spend, 2),
      purchaseValue: round(creative.purchaseValue, 2),
      roas: creative.spend > 0 ? round(creative.purchaseValue / creative.spend, 2) : 0,
      lifecycleState: creative.lifecycleState,
      confidence: creative.confidence,
    });
  }

  const patterns = Array.from(patternMap.values())
    .sort((left, right) => right.spend - left.spend)
    .slice(0, 8);
  const sortedFamilies = families.sort((left, right) => right.totalSpend - left.totalSpend);
  const protectedWinners = buildProtectedWinners(creatives);
  const supplyPlan = buildSupplyPlan(creatives, sortedFamilies);
  const opportunityBoard = buildCreativeOpportunityBoard({
    creatives,
    families: sortedFamilies,
    protectedWinners,
  });
  const lifecycleBoard = buildLifecycleBoard(creatives);
  const operatorQueues = buildOperatorQueues(creatives);
  const creativeHistoryCoverage =
    creatives.length === 0
      ? 0
      : creatives.filter(
          (creative) =>
            Boolean(
              creative.report?.timeframeContext ||
                creative.report?.benchmark?.sampleSize ||
                creative.report?.fatigue?.evidence.length,
            ),
        ).length / creatives.length;
  const nonLiveEvidence = evidenceSource !== "live";
  const sourceHealth: DecisionSourceHealthEntry[] = [
    {
      source: "Creative source",
      status:
        nonLiveEvidence
          ? evidenceSource === "unknown"
            ? "degraded"
            : "stale"
        : creatives.length === 0
          ? "degraded"
          : creativeHistoryCoverage >= 0.9
            ? "healthy"
            : creativeHistoryCoverage >= 0.5
              ? "stale"
              : "degraded",
      detail:
        nonLiveEvidence
          ? `Creative decisions are ${evidenceSource} evidence and remain contextual until live evidence is available.`
        : creatives.length === 0
          ? "No creative rows were available for the current decision window."
          : creativeHistoryCoverage >= 0.9
            ? "Creative rows and benchmark context resolved for the current decision window."
            : "Some creative rows are missing historical or benchmark context, so fallback posture stays labeled.",
      fallbackLabel:
        nonLiveEvidence
          ? `${evidenceSource} evidence`
          : creativeHistoryCoverage >= 0.9 ? null : "benchmark fallback",
    },
    {
      source: "Commercial truth",
      status:
        commercialTruthCoverage.summary?.freshness.status === "fresh"
          ? "healthy"
          : commercialTruthCoverage.summary?.freshness.status === "stale"
            ? "stale"
            : "degraded",
      detail:
        commercialTruthCoverage.summary?.freshness.reason ??
        "Commercial truth is configured for creative decisioning.",
      fallbackLabel:
        commercialTruthCoverage.summary?.freshness.status === "fresh"
          ? null
          : "shared trust ceiling",
    },
  ];
  const readReliability: DecisionReadReliability =
    nonLiveEvidence
      ? {
          status: evidenceSource === "unknown" ? "degraded" : "fallback",
          determinism: "watch",
          detail:
            "Creative surface remains deterministic, but non-live evidence is context-only and cannot authorize primary actions.",
        }
      : creatives.length > 0 &&
    creativeHistoryCoverage >= 0.9 &&
    (commercialTruthCoverage.summary?.freshness.status ?? "missing") === "fresh"
      ? {
          status: "stable",
          determinism: "stable",
          detail:
            "Repeated reads should stay stable because creative rows and shared commercial truth are current.",
        }
      : creatives.length === 0
        ? {
            status: "degraded",
            determinism: "unstable",
            detail:
              "The creative surface is in degraded mode because no rows were available for the current decision window.",
          }
        : {
            status: "fallback",
            determinism: "watch",
            detail:
              "The creative surface is still readable, but fallback and trust-capped decisions remain labeled until benchmark coverage improves.",
          };
  const surfaceSummary = {
    actionCoreCount: creatives.filter(
      (creative) => creative.operatorPolicy.state === "do_now",
    ).length,
    watchlistCount: creatives.filter(
      (creative) =>
        creative.operatorPolicy.state === "watch" ||
        creative.operatorPolicy.state === "investigate" ||
        creative.operatorPolicy.state === "do_not_touch",
    ).length,
    archiveCount: creatives.filter(
      (creative) =>
        creative.operatorPolicy.state === "contextual_only" ||
        creative.trust.surfaceLane === "archive_context",
    ).length,
    degradedCount: creatives.filter(
      (creative) =>
        creative.operatorPolicy.pushReadiness === "blocked_from_push" &&
        creative.operatorPolicy.state !== "do_not_touch",
    ).length,
    profitableTruthCappedCount: creatives.filter(
      (creative) => creative.trust.operatorDisposition === "profitable_truth_capped",
    ).length,
  };
  const previewCoverage = {
    readyCount: creatives.filter(
      (creative) => creative.previewStatus?.liveDecisionWindow === "ready",
    ).length,
    degradedCount: creatives.filter(
      (creative) => creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded",
    ).length,
    missingCount: creatives.filter(
      (creative) => creative.previewStatus?.liveDecisionWindow === "missing",
    ).length,
  };
  const readiness: DecisionSurfaceReadiness = {
    daysExpected: 30,
    daysReady:
      readReliability.status === "stable"
        ? 30
        : readReliability.status === "fallback"
          ? Math.max(8, 30 - Math.max(1, commercialTruthCoverage.missingInputs.length) * 4)
          : Math.max(0, previewCoverage.readyCount > 0 ? 7 : 0),
    missingInputs: commercialTruthCoverage.missingInputs,
    suppressedActionClasses: Array.from(
      new Set(
        [
          ...(commercialTruthCoverage.summary?.actionCeilings ?? []),
          ...creatives
            .filter((creative) => creative.trust.operatorDisposition === "profitable_truth_capped")
            .map(() => "promote_to_scaling"),
        ].filter(Boolean),
      ),
    ),
    previewCoverage,
  };
  const authority = buildDecisionSurfaceAuthority({
    scope: "Creative Decision OS",
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
    freshness: buildDecisionFreshness(),
    missingInputs: commercialTruthCoverage.missingInputs,
    reasons: commercialTruthCoverage.guardrails,
    actionCoreCount: surfaceSummary.actionCoreCount,
    watchlistCount: surfaceSummary.watchlistCount,
    archiveCount: surfaceSummary.archiveCount,
    suppressedCount:
      surfaceSummary.watchlistCount + surfaceSummary.archiveCount,
    note:
      commercialTruthCoverage.missingInputs.length > 0
        ? "Creative Decision OS remains visible but caps aggressive actions until truth coverage improves."
        : "Creative Decision OS is using the shared trust kernel without active truth caps.",
    readiness,
    sourceHealth,
    readReliability,
  });

  return {
    contractVersion: CREATIVE_DECISION_OS_CONTRACT_VERSION,
    engineVersion: CREATIVE_DECISION_OS_ENGINE_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    analyticsWindow: decisionMetadata.analyticsWindow,
    decisionWindows: decisionMetadata.decisionWindows,
    historicalMemory: decisionMetadata.historicalMemory,
    decisionAsOf: decisionMetadata.decisionAsOf,
    summary: {
      totalCreatives: creatives.length,
      scaleReadyCount: creatives.filter(
        (creative) =>
          creative.operatorPolicy.segment === "scale_ready",
      ).length,
      keepTestingCount: creatives.filter(
        (creative) =>
          creative.operatorPolicy.segment === "promising_under_sampled" ||
          creative.operatorPolicy.segment === "creative_learning_incomplete" ||
          creative.operatorPolicy.segment === "hold_monitor" ||
          creative.operatorPolicy.segment === "false_winner_low_evidence",
      ).length,
      fatiguedCount: creatives.filter(
        (creative) =>
          creative.operatorPolicy.segment === "fatigued_winner" ||
          creative.operatorPolicy.segment === "needs_new_variant",
      ).length,
      blockedCount: creatives.filter(
        (creative) =>
          creative.operatorPolicy.segment === "kill_candidate" ||
          creative.operatorPolicy.segment === "spend_waste" ||
          creative.operatorPolicy.segment === "blocked",
      ).length,
      comebackCount: creatives.filter((creative) => creative.lifecycleState === "comeback_candidate").length,
      protectedWinnerCount: protectedWinners.length,
      supplyPlanCount: supplyPlan.length,
      opportunitySummary: {
        totalCount: opportunityBoard.length,
        queueEligibleCount: opportunityBoard.filter((item) => item.queue.eligible).length,
        protectedCount: opportunityBoard.filter(
          (item) => item.kind === "protected_winner",
        ).length,
        familyScaleCount: opportunityBoard.filter(
          (item) => item.kind === "creative_family_winner_scale",
        ).length,
        headline:
          opportunityBoard.filter((item) => item.queue.eligible).length > 0
            ? `${opportunityBoard.filter((item) => item.queue.eligible).length} creative opportunity${opportunityBoard.filter((item) => item.queue.eligible).length > 1 ? " items are" : " item is"} ready once evidence floors stay intact.`
            : "Creative opportunity board is populated, but nothing is queue-ready yet.",
      },
      benchmarkScope: resolvedBenchmarkScopeMetadata,
      message:
        input.operatingMode?.recommendedMode === "Recovery"
          ? "Commercial truth is in a recovery posture, so Decision OS biases toward safer Test More, Diagnose, and Cut outcomes."
          : "Decision OS highlights Scale, Test More, Protect, Refresh, Cut, and Diagnose primary decisions with review-only and reason-tag context.",
      operatingMode: input.operatingMode?.recommendedMode ?? null,
      sourceHealth,
      readReliability,
      surfaceSummary,
      readiness,
    },
    creatives,
    families: sortedFamilies,
    patterns,
    protectedWinners,
    supplyPlan,
    opportunityBoard,
    lifecycleBoard,
    operatorQueues,
    commercialTruthCoverage,
    historicalAnalysis: buildEmptyCreativeHistoricalAnalysis({
      startDate: input.startDate,
      endDate: input.endDate,
      summary:
        "Selected-period historical analysis is attached separately and does not change deterministic Decision Signals.",
    }),
    authority,
  };
}

export function mapCreativeDecisionOsToLegacyDecisions(
  payload: Pick<CreativeDecisionOsV1Response, "creatives">,
) {
  return payload.creatives.map((creative) => ({
    creativeId: creative.creativeId,
    action: creative.legacyAction,
    lifecycleState: creative.legacyLifecycleState,
    score: creative.score,
    confidence: creative.confidence,
    scoringFactors: creative.report.factors.map((factor) => `${factor.label}: ${factor.value}`),
    reasons: creative.report.factors.map((factor) => `${factor.label}: ${factor.reason}`).slice(0, 4),
    nextStep: creative.summary,
  }));
}
