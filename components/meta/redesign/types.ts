import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export type MetaWindowKey = "7d" | "14d" | "28d" | "90d" | "custom";

export interface MetaPulsePayload {
  businessId: string;
  window: MetaWindowKey;
  statusFilter?: BriefingStatusFilter;
  startDate: string;
  endDate: string;
  pacing: {
    mtdSpend: number;
    mtdTarget: number;
    dayPace: number;
    spendToday?: number;
    dailyTarget?: number;
  };
  roas: {
    d7: number;
    d14: number;
    d28: number;
    target: number | null;
    median: number | null;
    target_source: "commercial_truth" | "account_median" | "none";
  };
  roasHistory?: number[];
  spend: { current: number; prev: number };
  revenue: { current: number; prev: number };
  cpa: { current: number | null; prev: number | null };
  matureCampaigns: number;
  learningCampaigns: number;
  operatingMode: string;
  seasonalRegime: string;
  engineLastRun: string | null;
  engineVersion: string;
  trackingHealth: { status: "healthy" | "degraded" | "blocked" | "syncing" | "unknown"; detail: string };
  trackingAnomalyActive?: boolean;
  lastSyncAt?: string | null;
}

export interface MetaHealthyEntity {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  spend: number;
  roas: number;
  cpa: number | null;
  status: string | null;
  optimizationGoal?: string | null;
  customEventType?: string | null;
  bidStrategyType?: string | null;
  bidStrategyLabel?: string | null;
  manualBidAmount?: number | null;
  previousManualBidAmount?: number | null;
  bidValue?: number | null;
  bidValueFormat?: "currency" | "roas" | null;
  previousBidValue?: number | null;
  previousBidValueFormat?: "currency" | "roas" | null;
  previousBidValueCapturedAt?: string | null;
  isOptimizationGoalMixed?: boolean;
  isCustomEventTypeMixed?: boolean;
  isBidStrategyMixed?: boolean;
  isBidValueMixed?: boolean;
}

export interface MetaArchivedEntity {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  status: string;
  statusLabel: string;
  spend: number;
  roas: number;
  cpa: number | null;
  purchases: number;
  lastKnownWindow: string;
  diagnosticNote: string | null;
}

export interface MetaLanePayload {
  businessId: string;
  startDate: string;
  endDate: string;
  sourceModel: string;
  snapshotDate: string | null;
  statusFilter?: BriefingStatusFilter;
  actionNow: MetaRecommendation[];
  watching: MetaRecommendation[];
  healthy: MetaHealthyEntity[];
  nonSales: MetaRecommendation[];
  archive: MetaArchivedEntity[];
  deferredIds: string[];
  counts: { actionNow: number; watching: number; healthy: number; nonSales: number; archive: number };
}

export type MetaDrillItem =
  | { mode: "decision"; rec: MetaRecommendation; relatedRecs?: MetaRecommendation[] }
  | { mode: "informational"; rec: MetaRecommendation }
  | { mode: "anomaly"; anomaly: MetaAnomaly };

export type MetaLaunchMode = "rebuild" | "duplicate" | "apply_bid";
