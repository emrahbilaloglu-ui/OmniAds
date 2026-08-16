import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type { MetaCampaignKind } from "@/lib/meta/campaign-label-types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsDecisionsPresentation } from "@/lib/meta/decisions-os-contract";

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
    target_source:
      "commercial_truth" | "commercial_truth_stale" | "account_median" | "none";
    targetFreshness?: "fresh" | "stale" | "unknown";
    targetUpdatedAt?: string | null;
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
  campaignContextMode?: "legacy_labels" | "automatic" | "unknown";
  snapshotHealth?: MetaSnapshotHealth | null;
  labelCoverage?: MetaLabelCoverage | null;
  targetAnchor?: MetaTargetAnchor | null;
  trackingHealth: {
    status: "healthy" | "degraded" | "blocked" | "syncing" | "unknown";
    detail: string;
  };
  trackingAnomalyActive?: boolean;
  /** Newest warehouse ingest timestamp; null = unknown, never fabricated. */
  lastSyncAt?: string | null;
  /** Ad-account currency code from warehouse rows; null = unknown. */
  currency?: string | null;
  dataReadiness?: {
    status:
      "ok" | "no_accounts_assigned" | "account_not_assigned" | "not_connected";
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
  freshness: "fresh" | "stale" | "unknown";
  updatedAt: string | null;
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

/**
 * Account-scoped provider inventory for the Structure surface. This is not a
 * recommendation: action authority remains in the server recommendation
 * envelope and the presentation layer merges it onto these rows.
 */
export interface MetaStructureInventoryEntity {
  id: string;
  level: "campaign" | "adset";
  name: string;
  campaignId: string | null;
  campaignName: string | null;
  campaignKind: MetaCampaignKind | null;
  status: string | null;
  statusLabel: string;
  metrics: {
    spend: number | null;
    purchases: number | null;
    roas: number | null;
    cpa: number | null;
    ctr: number | null;
    frequency: number | null;
  };
  entityConfiguration: NonNullable<
    MetaRecommendation["entityConfiguration"]
  >;
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
  advisory?: {
    decisionLabel: string | null;
    primaryActionLabel: string;
    why: string;
    confidence: "high" | "medium" | "low";
  } | null;
}

export interface MetaLanePayload {
  businessId: string;
  startDate: string;
  endDate: string;
  sourceModel: string;
  /** True snapshot_date of the served lane rows (not the range end). */
  snapshotDate: string | null;
  /** Engine write time (created_at) of the served snapshot rows. */
  snapshotCreatedAt?: string | null;
  statusFilter?: BriefingStatusFilter;
  actionNow: MetaRecommendation[];
  watching: MetaRecommendation[];
  healthy: MetaHealthyEntity[];
  nonSales: MetaRecommendation[];
  archive: MetaArchivedEntity[];
  /** Complete campaign/ad-set inventory for optional client-side filtering. */
  structureInventory?: MetaStructureInventoryEntity[];
  deferredIds: string[];
  watchingSegments?: MetaWatchingSegment[];
  snapshotHealth?: MetaSnapshotHealth | null;
  counts: {
    actionNow: number;
    watching: number;
    healthy: number;
    nonSales: number;
    archive: number;
  };
}

export type MetaDecisionsWorkspaceBannerTone =
  "info" | "warning" | "danger" | "success";

export interface MetaDecisionsWorkspaceBanner {
  id: string;
  tone: MetaDecisionsWorkspaceBannerTone;
  title: string;
  detail: string;
  blocking: boolean;
}

export interface MetaDecisionsWorkspaceViewer {
  role: "admin" | "collaborator" | "guest" | null;
  isReviewer: boolean;
  readOnly: boolean;
  readOnlyReason: string | null;
}

export interface MetaDecisionsDigest {
  snapshotDate: string | null;
  unavailableReason: string | null;
  labelFlips: {
    count: number;
    publishedCount: number;
    items: Array<{
      id: string;
      title: string;
      previousLabel: string;
      currentLabel: string;
      status: "published";
      occurredAt: string | null;
    }>;
  };
  actions: {
    verifiedCount: number;
    silentFailureCount: number;
    items: Array<{
      id: string;
      action: string;
      target: string;
      actor: string | null;
      status: "verified" | "silent_failure";
      occurredAt: string | null;
      detail: string | null;
    }>;
  };
  anomalies: {
    openedCount: number;
    items: Array<{
      id: string;
      title: string;
      status: "open" | "resolved";
      occurredAt: string | null;
    }>;
  };
  deferrals: {
    dueCount: number;
    items: Array<{
      id: string;
      title: string;
      dueAt: string | null;
      detail: string | null;
    }>;
  };
}

export interface MetaDecisionsWorkspacePayload {
  businessId: string;
  window: MetaWindowKey;
  statusFilter?: BriefingStatusFilter;
  startDate: string;
  endDate: string;
  pulse: MetaPulsePayload;
  lanes: MetaLanePayload;
  queue: {
    groups: Array<{
      key: "action" | "watching" | "healthy" | "nonSales" | "archive";
      label: string;
      count: number;
    }>;
    actionStates: {
      executablePause: number;
      executableBid: number;
      executableResume: number;
      launchpadRoutes: number;
      reviewOnly: number;
      missingActionKind: number;
    };
  };
  system: {
    trackingBlocked: boolean;
    dataReadiness: MetaPulsePayload["dataReadiness"] | null;
    snapshotHealth: MetaSnapshotHealth | null;
    laneSnapshotDate: string | null;
    laneSnapshotCreatedAt: string | null;
    engineVersion: string;
    currency: string | null;
    killSwitchEngaged: boolean;
    killSwitchReason: string | null;
  };
  viewer: MetaDecisionsWorkspaceViewer | null;
  banners: MetaDecisionsWorkspaceBanner[];
  digest: MetaDecisionsDigest;
  decisionReadModel: MetaDecisionsWorkspaceReadModel;
  os: MetaOsDecisionsPresentation;
}

/** Compact contract consumed by the route-owned Decisions OS. */
export interface MetaDecisionsOsWorkspacePayload {
  businessId: string;
  window: MetaWindowKey;
  statusFilter?: BriefingStatusFilter;
  startDate: string;
  endDate: string;
  /**
   * The account facts the Decision Center header states.
   *
   * A projection of the pulse the route already loaded — no extra query and no
   * new source. It is widened past `lastSyncAt` because the header's KPI strip
   * reports today's spend, ROAS against target, label coverage and operating
   * mode, and a surface that cannot read them would have to either omit them or
   * invent them. Every field stays optional at the source, so "unknown" remains
   * expressible and is never rendered as a zero.
   */
  pulse: Pick<
    MetaPulsePayload,
    | "lastSyncAt"
    | "pacing"
    | "roas"
    | "roasHistory"
    | "operatingMode"
    | "seasonalRegime"
    | "trackingHealth"
    | "labelCoverage"
  >;
  system: MetaDecisionsWorkspacePayload["system"];
  viewer: MetaDecisionsWorkspaceViewer | null;
  banners: MetaDecisionsWorkspaceBanner[];
  decisionReadModel: Pick<
    MetaDecisionsWorkspaceReadModel,
    "status" | "unavailable"
  >;
  os: MetaOsDecisionsPresentation;
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
  | {
      mode: "decision";
      rec: MetaRecommendation;
      relatedRecs?: MetaRecommendation[];
    }
  | { mode: "informational"; rec: MetaRecommendation }
  | { mode: "anomaly"; anomaly: MetaAnomaly };

export type MetaLaunchMode = "rebuild" | "duplicate" | "apply_bid";
