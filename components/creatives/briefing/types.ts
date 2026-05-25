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

export interface BriefingCtrFunnel {
  value?: number | null;
  p50?: number | null;
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
  truthSource?: TruthSource | string | null;
  spendUnitSource?: SpendUnitSource | string | null;
  spendUnitConfidence?: SpendUnitConfidence | string | null;
  metaAovQuality?: MetaAovQuality | string | null;
  thresholdQuality?: ThresholdQuality | string | null;
  badges?: Array<DecisionLabel | string> | null;
  blockers?: DecisionPredicateBlocker[] | null;
  confidence?: number | null;
  reason?: string | null;
  predictive?: string | null;
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
