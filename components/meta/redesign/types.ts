import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export type MetaWindowKey = "7d" | "14d" | "28d" | "90d" | "custom";

export interface MetaPulsePayload {
  businessId: string;
  window: MetaWindowKey;
  startDate: string;
  endDate: string;
  pacing: { mtdSpend: number; mtdTarget: number; dayPace: number };
  roas: { d7: number; d14: number; d28: number; target: number };
  spend: { current: number; prev: number };
  revenue: { current: number; prev: number };
  cpa: { current: number | null; prev: number | null };
  matureCampaigns: number;
  learningCampaigns: number;
  operatingMode: string;
  seasonalRegime: string;
  engineLastRun: string | null;
  engineVersion: string;
  trackingHealth: { status: "healthy" | "degraded" | "blocked" | "unknown"; detail: string };
  trackingAnomalyActive?: boolean;
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
}

export interface MetaLanePayload {
  businessId: string;
  startDate: string;
  endDate: string;
  sourceModel: string;
  snapshotDate: string | null;
  actionNow: MetaRecommendation[];
  watching: MetaRecommendation[];
  healthy: MetaHealthyEntity[];
  deferredIds: string[];
  counts: { actionNow: number; watching: number; healthy: number };
}

export type MetaDrillItem =
  | { mode: "decision"; rec: MetaRecommendation; relatedRecs?: MetaRecommendation[] }
  | { mode: "anomaly"; anomaly: MetaAnomaly };

export type MetaLaunchMode = "rebuild" | "duplicate" | "apply_bid";
