import type { DecisionLabel } from "@/components/common/briefing/types";
import type {
  MetaCampaignKind,
  MetaCampaignTestDimension,
} from "@/lib/meta/campaign-label-types";
import type {
  AccountDecisionProfile,
  DataHealth,
  DecisionLabelTransform,
} from "@/lib/creative-decision-engine";

export interface BriefingPrimaryAction {
  kind?: string | null;
  label?: string | null;
}

export interface BriefingCtrFunnel {
  value?: number | null;
  p50?: number | null;
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
  badges?: Array<DecisionLabel | string> | null;
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
  status?: string | null;
  ageDays?: number | null;
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
}

export interface MetaSummaryPulseResponse {
  totals?: {
    spend?: number | null;
    roas?: number | null;
    conversions?: number | null;
  } | null;
}

export interface CardSelectionProps {
  selected?: boolean;
  onSelectChange?: (id: string, selected: boolean) => void;
}
