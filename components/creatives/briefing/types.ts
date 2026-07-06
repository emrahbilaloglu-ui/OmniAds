import type { DecisionLabel } from "@/components/common/briefing/types";
import type {
  MetaCampaignKind,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type {
  AccountDecisionProfile,
  DataHealth,
  DecisionPredicateBlocker,
  DecisionLabelTransform,
  SpendUnitConfidence,
  SpendUnitSource,
  MetaAovQuality,
  ThresholdQuality,
  TruthSource,
} from "@/lib/creative-decision-engine";
import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";
// Type-only imports so the response interface can carry the production-default
// decisionCenter snapshot and its server-supplied row decision. UI components
// must not import decision-center builders/adapters or compute buyerAction
// locally.
import type {
  CreativeDecisionCenterRowDecision,
  DecisionCenterSnapshot,
} from "@/lib/creative-decision-center";

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
  rawLabel?: DecisionLabel | string | null;
  pendingTransition?: boolean | null;
  /** Ad-account currency for this card's money fields; null = unknown.
   * Load-bearing for cross-business surfaces (creative inbox) where rows
   * from different businesses must not all render as USD. */
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
    asOfDate: string | null;
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
