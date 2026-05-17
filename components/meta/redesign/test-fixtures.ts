import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaHealthyEntity, MetaLanePayload, MetaPulsePayload } from "@/components/meta/redesign/types";

export function metaRec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec_1",
    level: "campaign",
    campaignId: "cmp_1",
    campaignName: "ASC Prospecting",
    type: "rebuild_with_constraints",
    lens: "structure",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.82,
    confidenceReason: null,
    decisionState: "act",
    decision: "Rebuild campaign",
    title: "ASC Prospecting needs a cleaner rebuild",
    why: "Structure and bid signals are mixed.",
    summary: "The campaign is mature enough for a rebuild path.",
    recommendedAction: "Rebuild with clean adset separation.",
    expectedImpact: "Cleaner learning and less wasted spend.",
    evidence: [
      { label: "Core ROAS", value: "3.20x", tone: "positive" },
      { label: "Spend", value: "$1,200", tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict: "Strong signal.",
      selectedRangeOverlay: "28d window supports it.",
      historicalSupport: "Historical support exists.",
      seasonalityFlag: "none",
      note: null,
    },
    engineVersion: "v3.6.0-meta-taxonomy",
    calibrationScope: { type: "account", source: "28d_history" },
    signalQuality: { quality_status: "ready", confidence_cap: "high" },
    evidenceTrail: {
      roas_history: [2.2, 2.8, 3.2],
      peer_comparison: { p10: 1, p50: 2, p90: 4, this_value: 3.2 },
      regime_stability: 0.8,
      age_days: 42,
      recent_changes: [],
    },
    campaignRole: "prospecting_scale",
    bidRegime: "lowest_cost",
    cohort: "purchase",
    ...overrides,
  };
}

export function metaAnomaly(overrides: Partial<MetaAnomaly> = {}): MetaAnomaly {
  return {
    id: "anom_1",
    type: "policy_block",
    scopeType: "adset",
    scopeId: "adset_1",
    scopeLabel: "Broad Adset",
    severity: "high",
    kind: "anomaly",
    title: "Policy delivery block",
    detail: "One ad is rejected with delivery impact.",
    diagnostics: ["Ad 1: REJECTED"],
    detectedAt: "2026-05-06T03:00:00.000Z",
    ...overrides,
  };
}

export function metaHealthy(overrides: Partial<MetaHealthyEntity> = {}): MetaHealthyEntity {
  return {
    id: "cmp_healthy",
    level: "campaign",
    name: "Healthy ASC",
    spend: 820,
    roas: 3.1,
    cpa: 24,
    status: "ACTIVE",
    ...overrides,
  };
}

export function metaPulse(overrides: Partial<MetaPulsePayload> = {}): MetaPulsePayload {
  return {
    businessId: "biz_1",
    window: "28d",
    statusFilter: "active",
    startDate: "2026-04-10",
    endDate: "2026-05-07",
    pacing: {
      mtdSpend: 1200,
      mtdTarget: 2400,
      dayPace: 0.5,
      spendToday: 401,
      dailyTarget: 80,
      avg7dSpend: 350,
      conversionsToday: 1,
      avg7dConversions: 2,
    },
    roas: {
      d7: 2.8,
      d14: 3,
      d28: 3.2,
      target: 2.5,
      median: 2.1,
      target_source: "commercial_truth",
    },
    spend: { current: 1200, prev: 900 },
    revenue: { current: 3840, prev: 2500 },
    cpa: { current: 24, prev: 28 },
    matureCampaigns: 8,
    learningCampaigns: 2,
    operatingMode: "Exploit",
    seasonalRegime: "normalized",
    engineLastRun: "2026-05-07T03:00:00.000Z",
    engineVersion: "v3.6.0-meta-taxonomy",
    trackingHealth: { status: "healthy", detail: "Tracking signal is stable." },
    ...overrides,
  };
}

export function metaLanePayload(overrides: Partial<MetaLanePayload> = {}): MetaLanePayload {
  return {
    businessId: "biz_1",
    startDate: "2026-04-10",
    endDate: "2026-05-07",
    sourceModel: "snapshot_persistent",
    snapshotDate: "2026-05-07",
    statusFilter: "active",
    actionNow: [metaRec()],
    watching: [metaRec({ id: "rec_watch", decisionState: "watch", confidenceScore: 0.42 })],
    healthy: [metaHealthy()],
    nonSales: [],
    archive: [],
    deferredIds: [],
    counts: { actionNow: 1, watching: 1, healthy: 1, nonSales: 0, archive: 0 },
    ...overrides,
  };
}
