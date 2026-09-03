import type { DecisionLabel } from "@/components/common/briefing/types";
import type {
  MetaCampaignKind,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type {
  AccountDecisionProfile,
  DataHealth,
  DecisionAuthorityBlocker,
  DecisionPredicateBlocker,
  DecisionLabelTransform,
  SpendUnitConfidence,
  SpendUnitSource,
  MetaAovQuality,
  ThresholdQuality,
  TruthSource,
} from "@/lib/creative-decision-engine";
import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import type { MetaCreativeAssessmentPresentation } from "@/lib/meta/creative-assessment";
import type {
  MetaCanonicalDecision,
} from "@/lib/meta/decisions-workspace-contract";
// Type-only imports so the response interface can carry the production-default
// decisionCenter snapshot and its server-supplied row decision. UI components
// must not import decision-center builders/adapters or compute buyerAction
// locally.
import type {
  CreativeDecisionCenterRowDecision,
  DecisionCenterSnapshot,
} from "@/lib/creative-decision-center";

export type { CreativeDecisionCenterRowDecision };

export interface BriefingPrimaryAction {
  kind?: string | null;
  label?: string | null;
}

export interface BriefingDecisionExplainability {
  targetRoas?: number | null;
  ratioToTarget?: number | null;
  thresholdSource?: string | null;
  thresholdQuality?: ThresholdQuality | string | null;
  calibrationComputedAt?: string | null;
  thresholdProvenance?: {
    calibrationComputedAt: string | null;
    refitDueAt: string | null;
    source:
      | "operator_target"
      | "operator_target_stale"
      | "account_baseline"
      | "account_baseline_thin"
      | "global_default";
  } | null;
  spendUnit?: number | null;
  commercialMaturitySpend?: number | null;
  hardCutSpend?: number | null;
  scaleMinPurchases?: number | null;
  blockerCount?: number | null;
  blockerSummary?: string[] | null;
  nearMisses?: string[] | null;
  historicalPrecision?: number | null;
  historicalRecall?: number | null;
  expectedCalibrationError?: number | null;
  empiricalSampleSize?: number | null;
  bucketObservedRate?: number | null;
  bucketObservedSampleSize?: number | null;
  missingEvidence?: string[] | null;
}

export interface BriefingPriorityScore {
  score: number;
  band: "critical" | "high" | "medium" | "low";
  reason: string;
  inputs: {
    spend: number;
    ratioToTarget: number | null;
    confidenceFactor: number;
    spendAtRisk: number;
    opportunityValue: number;
    severityWeight: number;
    actionWeight: number;
  };
}

export interface BriefingCtrFunnel {
  value?: number | null;
  p50?: number | null;
}

export type BriefingWatchingSubBucket =
  | "near_action"
  | "test_maturing"
  | "diagnostic"
  | "waiting_on_role_resolution"
  /** @deprecated pre-D074b alias; parse-only for older payloads. */
  | "waiting_on_labels";

export interface BriefingLaneSummary {
  actionNow: number;
  watching: {
    total: number;
    nearAction: number;
    testMaturing: number;
    diagnostic: number;
    waitingOnLabels: number;
    other: number;
  };
  healthy: number;
  deferred: number;
  totalDecisions: number;
  coveragePct: number | null;
}

export interface BriefingCreativePreview {
  render_mode: "video" | "image" | "unavailable";
  image_url: string | null;
  video_url: string | null;
  poster_url: string | null;
  source: string | null;
  is_catalog: boolean;
}

/**
 * Additive, exact-ad projection of the persisted native decision. The legacy
 * Decision Center row remains presentation-only because its non-null
 * `buyerAction` contract cannot faithfully represent a canonical review-only
 * or unavailable action.
 */
export interface BriefingCanonicalNativeAdDecision {
  contractVersion: "briefing-canonical-native-ad.v1";
  identityGrain: "ad";
  decisionId: string;
  episodeId: string;
  sourceSnapshotId: string;
  adId: string;
  creativeId: string | null;
  identityResolution: {
    basis: "native_ad_exact";
    adActionEligible: boolean;
  };
  classification: Pick<
    MetaCanonicalDecision["classification"],
    | "decisionState"
    | "buyerAction"
    | "buyerLabel"
    | "executionAction"
    | "heldAction"
  >;
  sourceDecision: {
    label: string;
    authorityBlocker:
      MetaCanonicalDecision["sourceDecision"]["authorityBlocker"];
    confidence: number;
    reason: string;
    snapshotAsOf: string;
    computedAt: string;
  };
  sourceAuthority: {
    status: "native_exact" | "demo_synthetic_review_only";
    snapshotId: string;
    evaluationId: string;
    inputHash: string;
    decisionHash: string;
    engineVersion: string;
    providerAccountRefId: string;
    providerAccountId: string;
    realAdId: string;
    jobRunId: string;
    authorizedAction: "scale" | "cut" | "refresh" | null;
    actionEligible: boolean;
    reviewOnlyReason: string | null;
    executionReadiness?:
      | "decision_not_authorized"
      | "stale_decision"
      | "engine_version_drift"
      | "kill_switched"
      | "governance_unavailable"
      | "source_pipeline_unready"
      | "live_preflight_required";
    decisionFreshness?: {
      status: "fresh" | "stale" | "future" | "unavailable";
      computedAt: string | null;
      ageHours: number | null;
      maxAgeHours: number;
    };
  };
}

export interface BriefingCanonicalInventorySource {
  contractVersion: "briefing-canonical-native-ad.v1";
  status: "available" | "unavailable";
  unavailableReason: string | null;
  generation: {
    jobRunId: string;
    asOfDate: string;
    providerAccountRefId: string;
    manifestHash: string;
    expectedAdCount: number;
    authorityStatus?: "native_exact" | "demo_synthetic_review_only";
  } | null;
  itemCount: number;
}

export interface BriefingPlacement {
  id?: string | null;
  creativeId?: string | null;
  creative_id?: string | null;
  creativeName?: string | null;
  creative_name?: string | null;
  campaign?: string | null;
  campaignName?: string | null;
  adset?: string | null;
  adsetName?: string | null;
  spend?: number | null;
  roas?: number | null;
  status?: string | null;
  label?: DecisionLabel | string | null;
  confidence?: number | null;
}

export interface BriefingCreativeCard {
  id: string;
  adId?: string | null;
  realAdId?: string | null;
  metaAdId?: string | null;
  effectiveAdId?: string | null;
  accountId?: string | null;
  providerAccountId?: string | null;
  metaAccountId?: string | null;
  creativeId?: string | null;
  creativeName?: string | null;
  name?: string | null;
  brand?: string | null;
  campaign?: string | null;
  campaignName?: string | null;
  adset?: string | null;
  adsetName?: string | null;
  placements?: number | null;
  bestPlacement?: string | null;
  label?: DecisionLabel | string | null;
  watchingSubBucket?: BriefingWatchingSubBucket | null;
  truthSource?: TruthSource | string | null;
  preAuthorityLabel?: DecisionLabel | string | null;
  authorityBlocker?: DecisionAuthorityBlocker | string | null;
  rawLabel?: DecisionLabel | string | null;
  pendingTransition?: boolean | null;
  /** Ad-account currency for this card's money fields; null = unknown.
   * Account-scoped surfaces still render the card currency and never infer USD. */
  currency?: string | null;
  decisionHistory?: Array<{
    date: string;
    previousLabel: string | null;
    currentLabel: string;
    realizedOutcome7d?: string | null;
  }> | null;
  spendUnitSource?: SpendUnitSource | string | null;
  spendUnitConfidence?: SpendUnitConfidence | string | null;
  metaAovQuality?: MetaAovQuality | string | null;
  thresholdQuality?: ThresholdQuality | string | null;
  badges?: Array<DecisionLabel | string> | null;
  blockers?: DecisionPredicateBlocker[] | null;
  confidence?: number | null;
  reason?: string | null;
  predictive?: string | null;
  explainability?: BriefingDecisionExplainability | null;
  priorityScore?: BriefingPriorityScore | null;
  targetRoas?: number | null;
  ratioToTarget?: number | null;
  spend?: number | null;
  roas?: number | null;
  ctr?: number | null;
  cpa?: number | null;
  purchases?: number | null;
  impressions?: number | null;
  linkClicks?: number | null;
  addToCart?: number | null;
  frequency?: number | null;
  fatigue?: boolean | null;
  sparkline?: number[] | null;
  ctrFunnel?: BriefingCtrFunnel | null;
  primary?: BriefingPrimaryAction | null;
  automationReadiness?: MetaAutomationReadiness | null;
  decisionCenterRow?: CreativeDecisionCenterRowDecision | null;
  /** Server-owned assessment projection; clients render it without inference. */
  assessment?: MetaCreativeAssessmentPresentation | null;
  /** Immutable persisted source for Creative Brief lineage. Null means the
   * live card could not be reconciled to an account-scoped snapshot. */
  sourceDecisionSnapshotId?: string | null;
  sourceDecisionSnapshotAsOf?: string | null;
  sourceDecisionSnapshotEngineVersion?: string | null;
  sourceDecisionSnapshotMatch?: "matched" | "unavailable" | "mismatch" | null;
  sourceDecisionAuthorityStatus?:
    | "native_exact"
    | "demo_synthetic_review_only"
    | null;
  sourceDecisionEvaluationId?: string | null;
  sourceDecisionInputHash?: string | null;
  sourceDecisionHash?: string | null;
  sourceDecisionProviderAccountRefId?: string | null;
  sourceDecisionJobRunId?: string | null;
  sourceDecisionAuthorizedAction?: "scale" | "cut" | "refresh" | null;
  sourceDecisionActionEligible?: boolean | null;
  canonicalDecision?: BriefingCanonicalNativeAdDecision | null;
  status?: string | null;
  ageDays?: number | null;
  firstSeenAt?: string | null;
  firstSpendAt?: string | null;
  spend24h?: number | null;
  impressions24h?: number | null;
  reviewStatus?: string | null;
  disapprovalReason?: string | null;
  limitedReason?: string | null;
  campaignKind?: MetaCampaignKind | null;
  campaignTestDimension?: MetaCampaignTestDimension | null;
  /** Canonical automatic role-resolution status (D074b). */
  campaignRoleStatus?: "resolved" | "unresolved" | "no_campaign" | null;
  /** @deprecated pre-D074b alias; parse-only for older payloads. */
  campaignLabelStatus?: "labeled" | "unlabeled" | "no_campaign" | null;
  blockedActionType?: DecisionLabel | string | null;
  labelTransform?: DecisionLabelTransform | null;
  placementList?: BriefingPlacement[] | null;
  mixed?: boolean | null;
  engineVersion?: string | null;
  sourceAsOf?: string | null;
  sourceDataSource?: string | null;
  profileScope?: string | null;
  mediaPreviewUrl?: string | null;
  thumbnailUrl?: string | null;
  tableThumbnailUrl?: string | null;
  cardPreviewUrl?: string | null;
  previewUrl?: string | null;
  imageUrl?: string | null;
  cachedThumbnailUrl?: string | null;
  preview?: BriefingCreativePreview | null;
  previewState?: "preview" | "catalog" | "unavailable" | null;
  isCatalog?: boolean | null;
  format?: "image" | "video" | "catalog" | string | null;
  creativeDeliveryType?: string | null;
  creativeVisualFormat?: string | null;
  creativePrimaryType?: string | null;
  creativePrimaryLabel?: string | null;
  creativeSecondaryType?: string | null;
  creativeSecondaryLabel?: string | null;
  taxonomySource?: string | null;
  taxonomyReconciledByVideoEvidence?: boolean | null;
}

export interface BriefingRollupItem {
  id?: string | null;
  primaryRec: BriefingCreativeCard;
  placementList: BriefingPlacement[];
  mixed?: boolean | null;
}

export type BriefingActionItem = BriefingCreativeCard | BriefingRollupItem;

export interface CreativesBriefingPulse {
  matureCount?: number | null;
  spendTarget?: number | null;
  spendHistory?: number[] | null;
  rolling7dRoasTarget?: number | null;
  engineVersion?: string | null;
  calibratedAgo?: string | null;
  trackingAnomalyActive?: boolean | null;
  trackingDetail?: string | null;
  trackingAnomalyDetail?: string | null;
}

export interface CreativesBriefingMeasurementReconciliation {
  durationMs: number;
  queryCount: number;
  briefingCounts: {
    actionNow: number;
    watching: number;
    healthy: number;
    total: number;
  };
  decisionCenterRowCount: number | null;
  snapshotLatest: {
    /** The calendar day these rows describe. A label, never an age. */
    asOfDate: string | null;
    /**
     * When the rows were actually computed.
     *
     * The surface's as-of comes from here. `asOfDate` cannot serve: a bare date
     * parses as UTC midnight, so the same snapshot reads as a different age
     * depending on the hour and the account's offset.
     */
    observedAt: string | null;
    engineVersion: string | null;
    rowCount: number;
    conflictingGroups: number;
    staleRows: number;
    lifecycleRowCount: number | null;
  } | null;
  outcome: {
    currentVersionRows7d: number;
    currentVersionRows14d: number;
    first7dWindowClosesAt: string | null;
    first14dWindowClosesAt: string | null;
  } | null;
  dataCompleteness: {
    totalInputs: number;
    fields: Record<
      string,
      {
        present: number;
        total: number;
        coverage: number | null;
        criticalForActions?: string[];
      }
    >;
  };
  notes: string[];
}

export interface BriefingAggregateSuppressionTraceItem {
  index: number;
  action: string;
  scope: "page" | "family";
  familyId?: string | null;
  reason: string;
  missingRequiredData: string[];
  candidateMissingData: string[];
  prerequisites?: Array<{
    field: string;
    availableNow: boolean;
  }>;
}

export interface BriefingAggregateSuppressionTrace {
  candidateCount: number;
  emittedCount: number;
  suppressedCount: number;
  suppressed: BriefingAggregateSuppressionTraceItem[];
}

export interface CreativesBriefingResponse {
  actionNow: BriefingActionItem[];
  watching: BriefingCreativeCard[];
  healthy: BriefingCreativeCard[];
  deferredCount?: number | null;
  pulse?: CreativesBriefingPulse | null;
  trackingAnomalyActive?: boolean | null;
  trackingBlocked?: boolean | null;
  trackingDetail?: string | null;
  trackingAnomalyDetail?: string | null;
  source?: {
    dataSource?: string | null;
    asOf?: string | null;
    dataHealth?: DataHealth | null;
    accountProfile?: AccountDecisionProfile | null;
    measurementReconciliation?: CreativesBriefingMeasurementReconciliation | null;
    laneSummary?: BriefingLaneSummary | null;
    aggregateSuppressionTrace?: BriefingAggregateSuppressionTrace | null;
    canonicalDecisionInventory?: BriefingCanonicalInventorySource | null;
  } | null;
  /**
   * Additive production-default Decision Center snapshot. Null indicates the
   * snapshot was included but failed structural validation. UI consumption is
   * restricted to server-supplied fields such as
   * `BriefingCreativeCard.decisionCenterRow`; UI components must not compute
   * buyerAction from this snapshot.
   */
  decisionCenter?: DecisionCenterSnapshot | null;
}

export interface MetaSummaryPulseResponse {
  totals?: {
    spend?: number | null;
    roas?: number | null;
    conversions?: number | null;
  } | null;
}

export interface MetaTrendsPointResponse {
  date: string;
  roas?: number | null;
  spend?: number | null;
  revenue?: number | null;
  conversions?: number | null;
}

export interface MetaTrendsBriefingResponse {
  points?: MetaTrendsPointResponse[] | null;
  isPartial?: boolean | null;
}

export interface CardSelectionProps {
  selected?: boolean;
  onSelectChange?: (id: string, selected: boolean) => void;
}
