import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export type MetaWindowKey = "7d" | "14d" | "28d" | "90d" | "custom";

export interface MetaPulsePayload {
  businessId: string;
  window: MetaWindowKey;
  statusFilter?: BriefingStatusFilter;
  startDate: string;
  endDate: string;
  pacing: {
    /** True month-to-date spend (month start .. endDate). */
    mtdSpend: number;
    mtdTarget: number;
    dayPace: number;
    /** Selected-window spend (the old field incorrectly labeled MTD). */
    windowSpend?: number;
    spendToday?: number;
    dailyTarget?: number;
    avg7dSpend?: number;
    conversionsToday?: number;
    avg7dConversions?: number;
  };
  roas: {
    selected: number;
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
  snapshotHealth?: MetaSnapshotHealth | null;
  labelCoverage?: MetaLabelCoverage | null;
  targetAnchor?: MetaTargetAnchor | null;
  trackingHealth: { status: "healthy" | "degraded" | "blocked" | "syncing" | "unknown"; detail: string };
  trackingAnomalyActive?: boolean;
  /** Newest warehouse ingest timestamp; null = unknown, never fabricated. */
  lastSyncAt?: string | null;
  /** Ad-account currency code from warehouse rows; null = unknown. */
  currency?: string | null;
  dataReadiness?: {
    status: "ok" | "no_accounts_assigned" | "account_not_assigned" | "not_connected";
    isPartial: boolean;
    notReadyReason: string | null;
    evidenceSource: string;
  } | null;
}

export interface MetaLabelCoverage {
  activeCampaigns: number;
  labeledCampaigns: number;
  unlabeledCampaigns: number;
  latestUpdatedAt: string | null;
}

export interface MetaTargetAnchor {
  configured: boolean;
  source: "configured_targets" | "none";
  targetRoas: number | null;
  breakEvenRoas: number | null;
  targetCpa: number | null;
  breakEvenCpa: number | null;
}

export interface MetaSnapshotHealth {
  latestSnapshotDate: string | null;
  lastRunAt: string | null;
  engineVersion: string | null;
  currentEngineVersion: string;
  isCurrentEngineVersion: boolean;
  ageHours: number | null;
  status: "fresh" | "stale" | "missing" | "engine_version_mismatch";
  staleReason: string | null;
}

export interface MetaHealthyEntity {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId?: string | null;
  campaignName?: string | null;
  campaignKind?: MetaCampaignKind | null;
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
  campaignKind?: MetaCampaignKind | null;
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
  watchingSegments?: MetaWatchingSegment[];
  snapshotHealth?: MetaSnapshotHealth | null;
  counts: { actionNow: number; watching: number; healthy: number; nonSales: number; archive: number };
}

export type MetaWatchingSegmentKey =
  | "unlabeled"
  | "missing_target"
  | "learning"
  | "recently_changed"
  | "deferred"
  | "issues"
  | "mid_confidence"
  | "insufficient_signal"
  | "other";

export interface MetaWatchingSegment {
  key: MetaWatchingSegmentKey;
  label: string;
  count: number;
  description: string;
  ctaLabel: string | null;
  href: string | null;
}

export type MetaDrillItem =
  | { mode: "decision"; rec: MetaRecommendation; relatedRecs?: MetaRecommendation[] }
  | { mode: "informational"; rec: MetaRecommendation }
  | { mode: "anomaly"; anomaly: MetaAnomaly };

export type MetaLaunchMode = "rebuild" | "duplicate" | "apply_bid";
