import { getDb } from "@/lib/db";
import {
  buildDataLayerHealth,
  composeDataHealth,
  freshDataLayerHealth,
  STALE_TIER_WARNING_MAX_HOURS,
} from "./data-health";
import { computeFatigue, type HistoricalWindow } from "./fatigue";
import {
  computeMetaAttributedAov,
  type MetaAttributedAovResult,
} from "./meta-aov-calculator";
import { classifyMetaAovQuality } from "./spend-unit-resolver";
import type {
  AccountCalibration,
  AccountFunnelCalibration,
  CampaignObjective,
  CreativeFormat,
  CreativeInput,
  DataHealth,
  DataLayerHealth,
  EngineRiskPreset,
  FallbackMode,
  FormatFunnelBaseline,
  FunnelDiagnosis,
  FunnelStage,
  LifecyclePosition,
  MetaRanking,
  MetaAovQuality,
  SpendTrajectory,
  StaleTier,
} from "./types";
import type {
  OperatorResponseResult,
  OperatorResponseType,
} from "./operator-response-detection";

export interface BusinessTargetPack {
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: EngineRiskPreset | null;
}

export interface DecisionCalibrationProfileConfig {
  enginePresetLabel: EngineRiskPreset | null;
  zeroConvBurnerMultiplier: number | null;
  cutCandidateMultiplier: number | null;
  sustainedLoserMultiplier: number | null;
  hardCutMultiplier: number | null;
  scaleEvidenceMultiplier: number | null;
  scalePurchaseMultiplier: number | null;
  winnerMemoryMultiplier: number | null;
  recentSampleMultiplier: number | null;
  weakFunnelRateMultiplier: number | null;
  attributionAovAdjustmentMultiplier: number | null;
}

export interface CampaignCalibrationLookup {
  calibration: AccountCalibration | null;
  matureCreativeCount: number | null;
}

/**
 * Adapter interface for the engine's data dependencies.
 * MockDataSource is used in development/tests until the warehouse sync
 * (meta_creative_daily) is wired. WarehouseDataSource is the production
 * implementation, populated in a later phase.
 */
export interface CreativeDecisionDataSource {
  /** Hydrate a `CreativeInput` for a given creative as of a date. */
  getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null>;

  /** Return per-account self-calibrated values (Tier 3). */
  getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration>;

  /** Return campaign-scoped calibration, plus sample size when the row is unavailable. */
  getCampaignCalibration(input: {
    businessId: string;
    asOf: string;
    campaignId: string;
  }): Promise<CampaignCalibrationLookup>;

  /** Return per-format account funnel baselines (Phase 3.9). */
  getAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountFunnelCalibration>;

  /** Bulk fetch - used by surface to render a creative list. */
  listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]>;

  /**
   * Returns the data health snapshot for a business as of a given date.
   * Used by the API route to surface freshness in the response.
   */
  getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth>;

  /** Latest persisted funnel diagnosis for drawer evidence. */
  getLatestFunnelDiagnosis(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<FunnelDiagnosis | null>;

  /** Latest persisted operator response detector output for drawer evidence. */
  getLatestOperatorResponse(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<OperatorResponseResult | null>;

  /** Commercial truth used by the account-relative threshold resolver. */
  getBusinessTargetPack(input: {
    businessId: string;
  }): Promise<BusinessTargetPack | null>;

  /** Optional operator profile with preset and multiplier overrides. */
  getDecisionCalibrationProfile(input: {
    businessId: string;
    channel: "meta";
    objectiveFamily: "sales";
  }): Promise<DecisionCalibrationProfileConfig | null>;

  /** Live Meta-attributed AOV fallback for first-run calibration gaps. */
  getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
  }): Promise<MetaAttributedAovResult>;
}

/**
 * In-memory mock used until warehouse is ready. Returns deterministic test data.
 * The fixture roughly mirrors a small TheSwaf-like account.
 */
export class MockDataSource implements CreativeDecisionDataSource {
  async getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null> {
    return {
      creativeId: input.creativeId,
      creativeName: `Mock — ${input.creativeId}`,
      businessId: input.businessId,
      campaignId: "mock-campaign-001",
      objective: "OUTCOME_SALES",
      spend: 500,
      purchases: 8,
      purchaseValue: 1500,
      impressions: 50000,
      linkClicks: 600,
      roas: 3.0,
      cpa: 62.5,
      ctr: 1.2,
      frequency: 1.4,
      recent7dSpend: 120,
      recent7dPurchases: 2,
      recent7dRoas: 2.8,
      recent7dImpressions: 12000,
      effectiveStatus: "ACTIVE",
      ageDays: 21,
      lastSpendAt: input.asOf,
      policyReason: null,
      dataFreshnessHours: 6,
      fatigueStatus: "none",
      targetRoas: 2.2,
      breakevenRoas: 1.71,
      lifecyclePosition: "plateau",
      daysSincePeak: 5,
      peakRoas30d: 3.4,
      peakConfidence: 0.7,
      spendTrajectory30d: "flat",
      spendSlope7d: 0.5,
      spendSlope30d: 0.2,
      roasSlope7d: -0.05,
      roasSlope30d: 0.0,
      cpm: 10,
      outboundClicks: 520,
      landingPageViews: 480,
      addToCart: 80,
      initiateCheckout: 40,
      thumbstop: 25,
      video25Rate: 18,
      video50Rate: 10,
      video75Rate: 6,
      video100Rate: 3,
      qualityRanking: "average",
      engagementRateRanking: "average",
      conversionRateRanking: "average",
      creativeFormat: "video",
    };
  }

  async getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration> {
    return {
      businessId: input.businessId,
      computedAt: new Date().toISOString(),
      matureCreativeCount: 35,
      roasP75: 2.4,
      roasP60: 1.9,
      refreshRatioP10: 0.82,
      lowCtrP10: 0.7,
      accountCpaP50: 58,
      accountCpaSampleCount: 24,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      matureSpendP50: 300,
      matureSpendP75: 450,
      winnerSpendP25: 250,
      winnerSpendP50: 500,
      winnerPurchaseP50: 5,
      roasRatioP10: 0.4,
      roasRatioP25: 0.6,
      roasRatioP50: 1.0,
      roasRatioP75: 1.35,
      metaAovQuality: "ready",
    };
  }

  async getCampaignCalibration(input: {
    businessId: string;
  }): Promise<CampaignCalibrationLookup> {
    return {
      calibration: {
        businessId: input.businessId,
        computedAt: new Date().toISOString(),
        matureCreativeCount: 12,
        roasP75: 1.8,
        roasP60: 1.5,
        refreshRatioP10: 0.8,
        lowCtrP10: 0.6,
        accountCpaP50: 64,
        accountCpaSampleCount: 12,
        metaAttributedAovMean90d: 50,
        metaAttributedAovPurchaseCount90d: 20,
        metaAttributedRevenue90d: 1000,
        matureSpendP50: 180,
        matureSpendP75: 280,
        winnerSpendP25: 120,
        winnerSpendP50: 220,
        winnerPurchaseP50: 3,
        roasRatioP10: 0.35,
        roasRatioP25: 0.55,
        roasRatioP50: 0.9,
        roasRatioP75: 1.18,
        metaAovQuality: "ready",
      },
      matureCreativeCount: 12,
    };
  }

  async getAccountFunnelCalibration(): Promise<AccountFunnelCalibration> {
    return {
      byFormat: {
        overall: {
          creativeFormat: "overall",
          ctrP25: 0.8,
          ctrP50: 1.2,
          cpmP50: 12,
          cpmP75: 18,
          thumbstopP25: 15,
          thumbstopP50: 25,
          linkToLpvP25: 60,
          linkToLpvP50: 75,
          linkToAtcP25: 8,
          linkToAtcP50: 12,
          lpvToAtcP25: 10,
          lpvToAtcP50: 16,
          atcToIcP25: 35,
          atcToIcP50: 50,
          icToPurchaseP25: 20,
          icToPurchaseP50: 30,
          clickToPurchaseP25: 0.8,
          clickToPurchaseP50: 1.2,
          sampleSize: 35,
          qualityStatus: "ready",
        },
      },
    };
  }

  async listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const ids = input.creativeIds ?? [
      "mock-creative-001",
      "mock-creative-002",
      "mock-creative-003",
    ];
    const results = await Promise.all(
      ids.map((creativeId) =>
        this.getCreativeInput({
          creativeId,
          businessId: input.businessId,
          asOf: input.asOf,
        }),
      ),
    );
    return results.filter((result): result is CreativeInput => result !== null);
  }

  async getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth> {
    return composeDataHealth({
      calibration: freshDataLayerHealth(input.asOf),
      lifecycle: freshDataLayerHealth(input.asOf),
      decisions: freshDataLayerHealth(input.asOf),
    });
  }

  async getLatestFunnelDiagnosis(): Promise<FunnelDiagnosis | null> {
    return {
      primaryWeakStage: "none",
      creativeResponsible: false,
      confidence: 1,
      evidence: ["mock funnel rates are not below weak thresholds"],
      rates: {
        ctr: 1.2,
        outboundClickRate: 1.04,
        linkToLpvRate: 80,
        linkToAtcRate: 13.33,
        lpvToAtcRate: 16.67,
        atcToIcRate: 50,
        icToPurchaseRate: 20,
        atcToPurchaseRate: 10,
        clickToPurchaseRate: 1.33,
      },
    };
  }

  async getLatestOperatorResponse(): Promise<OperatorResponseResult | null> {
    return {
      responseType: "ignored",
      decisionRecommendedAt: "2026-05-01",
      operatorResponseDetectedAt: "2026-05-04T00:00:00.000Z",
      confidence: 0.72,
      evidence: ["mock operator response evidence"],
      signals: {
        spendSlope7d: 0,
        budgetChangeAmount: null,
        actionJournalReceiptCount: 0,
        statusChanged: false,
        roasDecayPct: null,
        frequencyRosePct: null,
      },
    };
  }

  async getBusinessTargetPack(): Promise<BusinessTargetPack | null> {
    return {
      targetCpa: null,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.71,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced",
    };
  }

  async getDecisionCalibrationProfile(): Promise<DecisionCalibrationProfileConfig | null> {
    return null;
  }

  async getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
  }): Promise<MetaAttributedAovResult> {
    const windowDays = input.windowDays ?? 90;
    const end = new Date(`${input.asOf}T00:00:00.000Z`);
    const start = Number.isNaN(end.getTime())
      ? input.asOf
      : new Date(
          end.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000,
        ).toISOString().slice(0, 10);
    return {
      aovMean: 50,
      purchaseCount: 42,
      totalRevenue: 2100,
      windowStart: start,
      windowEnd: input.asOf,
    };
  }
}

const CAMPAIGN_OBJECTIVES = new Set<CampaignObjective>([
  "OUTCOME_SALES",
  "OUTCOME_ENGAGEMENT",
  "OUTCOME_TRAFFIC",
  "OUTCOME_LEADS",
  "OUTCOME_AWARENESS",
  "OUTCOME_APP_PROMOTION",
]);

type EffectiveStatus = CreativeInput["effectiveStatus"];

const EFFECTIVE_STATUSES = new Set<NonNullable<EffectiveStatus>>([
  "ACTIVE",
  "PAUSED",
  "DELETED",
  "REJECTED",
]);

const FATIGUE_STATUSES = new Set<NonNullable<CreativeInput["fatigueStatus"]>>([
  "none",
  "watch",
  "fatigued",
  "unknown",
]);

const LIFECYCLE_POSITIONS = new Set<LifecyclePosition>([
  "rising",
  "plateau",
  "closing",
  "past_peak_inaction",
  "past_peak_natural",
  "past_peak_unclear",
  "volatile",
  "insufficient_history",
]);

const SPEND_TRAJECTORIES = new Set<SpendTrajectory>([
  "rising",
  "flat",
  "falling",
  "volatile",
  "unknown",
]);

const META_RANKINGS = new Set<MetaRanking>([
  "above_average",
  "average",
  "below_average",
  "unknown",
]);

const CREATIVE_FORMATS = new Set<CreativeFormat>([
  "image",
  "video",
  "carousel",
  "catalog",
  "other",
]);

const FUNNEL_STAGES = new Set<FunnelStage>([
  "upper_funnel",
  "landing_page",
  "checkout",
  "tracking",
  "none",
  "insufficient_signal",
]);

const OPERATOR_RESPONSE_TYPES = new Set<OperatorResponseType>([
  "scaled",
  "scaled_natural_saturation",
  "ignored",
  "paused",
  "creative_archived",
  "budget_decreased",
  "unknown",
  "no_recommendation",
]);

type CreativeHydrationRow = Record<string, unknown> & {
  creative_id: unknown;
  creative_name: unknown;
  spend: unknown;
  purchases: unknown;
  purchase_value: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  recent_spend: unknown;
  recent_purchases: unknown;
  recent_impressions: unknown;
  recent_roas: unknown;
  effective_status: unknown;
  objective: unknown;
  campaign_id: unknown;
  last_spend_date: unknown;
  policy_reason: unknown;
  age_days: unknown;
  data_freshness_hours: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  cpm: unknown;
  outbound_clicks: unknown;
  landing_page_views: unknown;
  add_to_cart: unknown;
  initiate_checkout: unknown;
  thumbstop: unknown;
  video25_rate: unknown;
  video50_rate: unknown;
  video75_rate: unknown;
  video100_rate: unknown;
  quality_ranking: unknown;
  engagement_rate_ranking: unknown;
  conversion_rate_ranking: unknown;
  creative_format: unknown;
};

type CalibrationRow = Record<string, unknown> & {
  mature_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  refresh_ratio_p10: unknown;
  refresh_ratio_count: unknown;
  low_ctr_p10: unknown;
  ctr_count: unknown;
  account_cpa_p50: unknown;
  account_cpa_sample_count: unknown;
  meta_attributed_aov_mean_90d: unknown;
  meta_attributed_aov_purchase_count_90d: unknown;
  meta_attributed_revenue_90d: unknown;
  meta_aov_quality: unknown;
  mature_spend_p50: unknown;
  mature_spend_p75: unknown;
  winner_spend_p25: unknown;
  winner_spend_p50: unknown;
  winner_purchase_p50: unknown;
  roas_ratio_p10: unknown;
  roas_ratio_p25: unknown;
  roas_ratio_p50: unknown;
  roas_ratio_p75: unknown;
  source_min_date: unknown;
  source_max_date: unknown;
  source_max_updated_at: unknown;
};

type SourceMaxUpdatedAtRow = Record<string, unknown> & {
  source_max_updated_at: unknown;
};

type CalibrationTableRow = Record<string, unknown> & {
  business_ref_id: unknown;
  engine_version: unknown;
  mature_creative_count: unknown;
  roas_p75: unknown;
  roas_p60: unknown;
  refresh_ratio_p10: unknown;
  low_ctr_p10: unknown;
  account_cpa_p50: unknown;
  account_cpa_sample_count: unknown;
  meta_attributed_aov_mean_90d: unknown;
  meta_attributed_aov_purchase_count_90d: unknown;
  meta_attributed_revenue_90d: unknown;
  meta_aov_quality: unknown;
  mature_spend_p50: unknown;
  mature_spend_p75: unknown;
  winner_spend_p25: unknown;
  winner_spend_p50: unknown;
  winner_purchase_p50: unknown;
  roas_ratio_p10: unknown;
  roas_ratio_p25: unknown;
  roas_ratio_p50: unknown;
  roas_ratio_p75: unknown;
  computed_at: unknown;
  source_max_updated_at: unknown;
  source_max_date: unknown;
  as_of_date: unknown;
  quality_status: unknown;
};

type FunnelCalibrationTableRow = Record<string, unknown> & {
  creative_format: unknown;
  ctr_p25: unknown;
  ctr_p50: unknown;
  cpm_p50: unknown;
  cpm_p75: unknown;
  thumbstop_p25: unknown;
  thumbstop_p50: unknown;
  link_to_lpv_p25: unknown;
  link_to_lpv_p50: unknown;
  link_to_atc_p25: unknown;
  link_to_atc_p50: unknown;
  lpv_to_atc_p25: unknown;
  lpv_to_atc_p50: unknown;
  atc_to_ic_p25: unknown;
  atc_to_ic_p50: unknown;
  ic_to_purchase_p25: unknown;
  ic_to_purchase_p50: unknown;
  click_to_purchase_p25: unknown;
  click_to_purchase_p50: unknown;
  funnel_sample_count: unknown;
  funnel_quality_status: unknown;
};

type BusinessTargetPackRow = Record<string, unknown> & {
  target_cpa: unknown;
  target_roas: unknown;
  break_even_cpa: unknown;
  break_even_roas: unknown;
  aov_assumption: unknown;
  default_risk_posture: unknown;
};

type DecisionCalibrationProfileRow = Record<string, unknown> & {
  engine_preset_label: unknown;
  zero_conv_burner_multiplier: unknown;
  cut_candidate_multiplier: unknown;
  sustained_loser_multiplier: unknown;
  hard_cut_multiplier: unknown;
  scale_evidence_multiplier: unknown;
  scale_purchase_multiplier: unknown;
  winner_memory_multiplier: unknown;
  recent_sample_multiplier: unknown;
  weak_funnel_rate_multiplier: unknown;
  attribution_aov_adjustment_multiplier: unknown;
};

type LifecycleTableHydrationRow = Record<string, unknown> & {
  creative_id: unknown;
  creative_name: unknown;
  campaign_id: unknown;
  objective: unknown;
  spend: unknown;
  purchases: unknown;
  purchase_value: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  recent_spend: unknown;
  recent_purchases: unknown;
  recent_roas: unknown;
  recent_impressions: unknown;
  effective_status: unknown;
  age_days: unknown;
  last_active_date: unknown;
  policy_reason: unknown;
  source_max_updated_at: unknown;
  data_freshness_hours: unknown;
  fatigue_status: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  lifecycle_position: unknown;
  days_since_peak: unknown;
  peak_roas_30d: unknown;
  peak_confidence: unknown;
  spend_trajectory_30d: unknown;
  spend_slope_7d: unknown;
  spend_slope_30d: unknown;
  roas_slope_7d: unknown;
  roas_slope_30d: unknown;
  cpm: unknown;
  outbound_clicks: unknown;
  landing_page_views: unknown;
  add_to_cart: unknown;
  initiate_checkout: unknown;
  thumbstop: unknown;
  video25_rate: unknown;
  video50_rate: unknown;
  video75_rate: unknown;
  video100_rate: unknown;
  quality_ranking: unknown;
  engagement_rate_ranking: unknown;
  conversion_rate_ranking: unknown;
  creative_format: unknown;
};

type LifecycleHealthRow = Record<string, unknown> & {
  computed_at: unknown;
  source_max_updated_at: unknown;
  as_of_date: unknown;
  engine_version: unknown;
  row_count: unknown;
};

type FunnelDiagnosisTableRow = Record<string, unknown> & {
  ctr_28d: unknown;
  outbound_click_rate_28d: unknown;
  link_to_lpv_rate_28d: unknown;
  link_to_atc_rate_28d: unknown;
  lpv_to_atc_rate_28d: unknown;
  atc_to_ic_rate_28d: unknown;
  ic_to_purchase_rate_28d: unknown;
  atc_to_purchase_rate_28d: unknown;
  click_to_purchase_rate_28d: unknown;
  funnel_primary_weak_stage: unknown;
  funnel_confidence: unknown;
  funnel_evidence: unknown;
  creative_responsibility_score: unknown;
};

type OperatorResponseEventRow = Record<string, unknown> & {
  operator_evidence: unknown;
};

interface CalibrationReadMetadata {
  businessId: string;
  requestedAsOf: string;
  asOfDate: string | null;
  computedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  fallbackMode: FallbackMode;
  note: string | null;
  staleTierOverride?: StaleTier;
}

const HYDRATE_CREATIVE_INPUTS_QUERY = `
WITH input_creatives AS (
  SELECT DISTINCT input.creative_id
  FROM unnest($3::text[]) AS input(creative_id)
  WHERE $4::boolean
),
latest_status AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.effective_status
  FROM meta_creative_daily d
  WHERE NOT $4::boolean
    AND d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
selected_creatives AS (
  SELECT creative_id
  FROM input_creatives

  UNION

  SELECT DISTINCT d.creative_id
  FROM meta_creative_daily d
  WHERE NOT $4::boolean
    AND d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '29 days') AND $2::date
    AND d.spend > 0

  UNION

  SELECT creative_id
  FROM latest_status
  WHERE effective_status = 'ACTIVE'
),
cumulative AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.conversions) AS purchases,
    SUM(d.revenue) AS purchase_value,
    SUM(d.impressions) AS impressions,
    SUM(d.link_clicks) AS link_clicks,
    CASE WHEN SUM(d.spend) > 0 THEN SUM(d.revenue) / SUM(d.spend) END AS roas,
    CASE WHEN SUM(d.conversions) > 0 THEN SUM(d.spend) / SUM(d.conversions) END AS cpa,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(d.clicks)::numeric / NULLIF(SUM(d.impressions), 0) * 100
    END AS ctr,
    AVG(d.frequency) FILTER (WHERE d.frequency > 0) AS frequency,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(d.spend) / NULLIF(SUM(d.impressions), 0) * 1000
    END AS cpm,
    SUM(COALESCE((NULLIF(d.payload_json->>'outbound_clicks', ''))::numeric, d.outbound_clicks::numeric, 0)) AS outbound_clicks,
    SUM(COALESCE((NULLIF(d.payload_json->>'landing_page_views', ''))::numeric, 0)) AS landing_page_views,
    SUM(COALESCE((NULLIF(d.payload_json->>'add_to_cart', ''))::numeric, 0)) AS add_to_cart,
    SUM(COALESCE((NULLIF(d.payload_json->>'initiate_checkout', ''))::numeric, 0)) AS initiate_checkout,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(COALESCE((NULLIF(d.payload_json->>'thumbstop', ''))::numeric, 0) * d.impressions) / NULLIF(SUM(d.impressions), 0)
    END AS thumbstop,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(COALESCE((NULLIF(d.payload_json->>'video25', ''))::numeric, 0) * d.impressions) / NULLIF(SUM(d.impressions), 0)
    END AS video25_rate,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(COALESCE((NULLIF(d.payload_json->>'video50', ''))::numeric, 0) * d.impressions) / NULLIF(SUM(d.impressions), 0)
    END AS video50_rate,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(COALESCE((NULLIF(d.payload_json->>'video75', ''))::numeric, 0) * d.impressions) / NULLIF(SUM(d.impressions), 0)
    END AS video75_rate,
    CASE
      WHEN SUM(d.impressions) > 0
      THEN SUM(COALESCE((NULLIF(d.payload_json->>'video100', ''))::numeric, 0) * d.impressions) / NULLIF(SUM(d.impressions), 0)
    END AS video100_rate
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
  GROUP BY d.creative_id
),
recent AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.conversions) AS purchases,
    SUM(d.impressions) AS impressions,
    CASE WHEN SUM(d.spend) > 0 THEN SUM(d.revenue) / SUM(d.spend) END AS roas
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
  GROUP BY d.creative_id
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.effective_status,
    d.objective,
    d.campaign_id,
    d.creative_name,
    d.first_spend_at,
    d.launch_date,
    d.updated_at,
    d.quality_ranking,
    d.engagement_rate_ranking,
    d.conversion_rate_ranking,
    COALESCE(
      NULLIF(d.payload_json->>'format', ''),
      NULLIF(d.payload_json->>'creative_format', ''),
      d.creative_visual_format,
      d.creative_primary_type
    ) AS creative_format,
    NULLIF(d.payload_json->>'policy_reason', '') AS policy_reason,
    CASE
      WHEN d.first_spend_at IS NOT NULL
      THEN ($2::date - d.first_spend_at::date)
    END AS age_days,
    CASE
      WHEN d.updated_at IS NOT NULL
      THEN FLOOR(EXTRACT(EPOCH FROM (now() - d.updated_at)) / 3600)
    END AS data_freshness_hours
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
last_spend AS (
  SELECT d.creative_id, MAX(d.date) AS last_spend_date
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
    AND d.spend > 0
  GROUP BY d.creative_id
),
target_pack AS (
  SELECT target_roas, break_even_roas
  FROM business_target_packs
  WHERE business_id = $1::uuid
  ORDER BY updated_at DESC
  LIMIT 1
),
historical_source AS (
  SELECT
    d.creative_id,
    windows.window_key,
    d.spend,
    d.impressions,
    d.clicks,
    d.conversions,
    d.revenue,
    d.link_clicks
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  CROSS JOIN LATERAL (
    VALUES
      ('last14', d.date BETWEEN ($2::date - INTERVAL '13 days') AND $2::date),
      ('last30', d.date BETWEEN ($2::date - INTERVAL '29 days') AND $2::date),
      ('last90', d.date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date),
      ('allHistory', d.date <= $2::date)
  ) AS windows(window_key, in_window)
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
    AND windows.in_window
),
historical_aggregates AS (
  SELECT
    creative_id,
    window_key,
    COUNT(*) AS row_count,
    SUM(spend) AS spend,
    CASE
      WHEN SUM(impressions) > 0
      THEN SUM(clicks)::numeric / NULLIF(SUM(impressions), 0) * 100
    END AS ctr,
    CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) END AS roas,
    CASE
      WHEN SUM(link_clicks) > 0
      THEN SUM(conversions) / NULLIF(SUM(link_clicks), 0)
    END AS click_to_purchase_rate,
    SUM(conversions) AS purchases
  FROM historical_source
  GROUP BY creative_id, window_key
),
historical AS (
  SELECT
    creative_id,
    MAX(row_count) FILTER (WHERE window_key = 'last14') AS last14_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last14') AS last14_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last14') AS last14_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last14') AS last14_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last14') AS last14_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last14') AS last14_purchases,

    MAX(row_count) FILTER (WHERE window_key = 'last30') AS last30_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last30') AS last30_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last30') AS last30_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last30') AS last30_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last30') AS last30_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last30') AS last30_purchases,

    MAX(row_count) FILTER (WHERE window_key = 'last90') AS last90_row_count,
    MAX(spend) FILTER (WHERE window_key = 'last90') AS last90_spend,
    MAX(ctr) FILTER (WHERE window_key = 'last90') AS last90_ctr,
    MAX(roas) FILTER (WHERE window_key = 'last90') AS last90_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'last90') AS last90_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'last90') AS last90_purchases,

    MAX(row_count) FILTER (WHERE window_key = 'allHistory') AS all_history_row_count,
    MAX(spend) FILTER (WHERE window_key = 'allHistory') AS all_history_spend,
    MAX(ctr) FILTER (WHERE window_key = 'allHistory') AS all_history_ctr,
    MAX(roas) FILTER (WHERE window_key = 'allHistory') AS all_history_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'allHistory') AS all_history_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'allHistory') AS all_history_purchases
  FROM historical_aggregates
  GROUP BY creative_id
)
SELECT
  c.creative_id,
  c.spend,
  c.purchases,
  c.purchase_value,
  c.impressions,
  c.link_clicks,
  c.roas,
  c.cpa,
  c.ctr,
  c.frequency,
  r.spend AS recent_spend,
  r.purchases AS recent_purchases,
  r.impressions AS recent_impressions,
  r.roas AS recent_roas,
  m.effective_status,
  m.objective,
  m.campaign_id,
  m.creative_name,
  m.policy_reason,
  m.age_days,
  m.data_freshness_hours,
  c.cpm,
  c.outbound_clicks,
  c.landing_page_views,
  c.add_to_cart,
  c.initiate_checkout,
  c.thumbstop,
  c.video25_rate,
  c.video50_rate,
  c.video75_rate,
  c.video100_rate,
  m.quality_ranking,
  m.engagement_rate_ranking,
  m.conversion_rate_ranking,
  m.creative_format,
  ls.last_spend_date,
  tp.target_roas,
  tp.break_even_roas,
  h.last14_row_count,
  h.last14_spend,
  h.last14_ctr,
  h.last14_roas,
  h.last14_click_to_purchase_rate,
  h.last14_purchases,
  h.last30_row_count,
  h.last30_spend,
  h.last30_ctr,
  h.last30_roas,
  h.last30_click_to_purchase_rate,
  h.last30_purchases,
  h.last90_row_count,
  h.last90_spend,
  h.last90_ctr,
  h.last90_roas,
  h.last90_click_to_purchase_rate,
  h.last90_purchases,
  h.all_history_row_count,
  h.all_history_spend,
  h.all_history_ctr,
  h.all_history_roas,
  h.all_history_click_to_purchase_rate,
  h.all_history_purchases
FROM cumulative c
LEFT JOIN recent r USING (creative_id)
LEFT JOIN latest_meta m USING (creative_id)
LEFT JOIN last_spend ls USING (creative_id)
LEFT JOIN target_pack tp ON true
LEFT JOIN historical h USING (creative_id)
ORDER BY c.spend DESC, c.creative_id ASC
`;

const ACCOUNT_CALIBRATION_QUERY = `
WITH target_pack AS (
  SELECT target_roas
  FROM business_target_packs
  WHERE business_id = $2::uuid
  ORDER BY updated_at DESC
  LIMIT 1
),
per_creative_raw AS (
  SELECT
    creative_id,
    SUM(spend) AS total_spend,
    SUM(conversions) AS total_purchases,
    SUM(revenue) AS total_revenue,
    SUM(spend) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_spend,
    SUM(revenue) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_revenue,
    SUM(impressions) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_impressions,
    SUM(clicks) FILTER (WHERE date >= ($1::date - INTERVAL '27 days')) AS cumulative_28d_clicks,
    SUM(spend) FILTER (WHERE date >= ($1::date - INTERVAL '6 days')) AS recent_7d_spend,
    SUM(revenue) FILTER (WHERE date >= ($1::date - INTERVAL '6 days')) AS recent_7d_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
  GROUP BY creative_id
),
per_creative AS (
  SELECT
    creative_id,
    total_spend,
    total_purchases,
    total_revenue,
    CASE WHEN total_spend > 0 THEN total_revenue / total_spend END AS aggregate_roas,
    CASE
      WHEN cumulative_28d_spend > 0
      THEN cumulative_28d_revenue / cumulative_28d_spend
    END AS cumulative_28d_roas,
    CASE
      WHEN cumulative_28d_impressions > 0
      THEN cumulative_28d_clicks::numeric / NULLIF(cumulative_28d_impressions, 0) * 100
    END AS cumulative_28d_ctr,
    CASE
      WHEN recent_7d_spend > 0
      THEN recent_7d_revenue / recent_7d_spend
    END AS recent_7d_roas
  FROM per_creative_raw
),
converter_population AS (
  SELECT *
  FROM per_creative
  WHERE total_purchases >= 1
    AND total_revenue > 0
    AND total_spend > 0
),
winner_population AS (
  SELECT cp.*
  FROM converter_population cp
  CROSS JOIN target_pack tp
  WHERE tp.target_roas IS NOT NULL
    AND cp.aggregate_roas >= tp.target_roas
),
recent_ratios AS (
  SELECT
    creative_id,
    CASE
      WHEN recent_7d_roas > 0 AND cumulative_28d_roas > 0
      THEN recent_7d_roas / cumulative_28d_roas
    END AS recent_total_ratio
  FROM per_creative
),
counts AS (
  SELECT
    (SELECT COUNT(*) FROM per_creative WHERE total_spend > 0) AS eligible_creative_count,
    (SELECT COUNT(*) FROM converter_population) AS converter_count,
    (SELECT COUNT(*) FROM winner_population) AS winner_count,
    (SELECT COUNT(*) FROM per_creative WHERE total_purchases > 0) AS account_cpa_sample_count,
    (SELECT COUNT(*) FROM per_creative WHERE total_spend > 0 AND COALESCE(total_purchases, 0) = 0) AS zero_conversion_count,
    (SELECT COUNT(*) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_count,
    (SELECT COUNT(*) FROM per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS ctr_count
),
percentiles AS (
  SELECT
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend / NULLIF(total_purchases, 0))
      FILTER (WHERE total_purchases > 0) AS cpa_p50_raw,
    percentile_cont(0.10) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p10_raw,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p25_raw,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p50_raw,
    percentile_cont(0.60) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p60_raw,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY aggregate_roas) AS roas_p75_raw,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend) AS mature_spend_p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY total_spend) AS mature_spend_p75,
    percentile_cont(0.10) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p10,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY aggregate_roas / NULLIF(tp.target_roas, 0))
      FILTER (WHERE tp.target_roas IS NOT NULL) AS roas_ratio_p75
  FROM converter_population cp
  CROSS JOIN target_pack tp
),
winner_percentiles AS (
  SELECT
    percentile_cont(0.25) WITHIN GROUP (ORDER BY total_spend) AS winner_spend_p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_spend) AS winner_spend_p50,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY total_purchases) AS winner_purchase_p50
  FROM winner_population
),
meta_aov AS (
  SELECT
    CASE WHEN SUM(conversions) > 0 THEN SUM(revenue) / SUM(conversions) END AS aov_mean,
    COALESCE(SUM(conversions), 0)::integer AS purchase_count,
    COALESCE(SUM(revenue), 0) AS total_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
    AND objective = 'OUTCOME_SALES'
),
source_bounds AS (
  SELECT
    MIN(date) AS source_min_date,
    MAX(date) AS source_max_date,
    MAX(updated_at) AS source_max_updated_at
  FROM meta_creative_daily
  WHERE business_ref_id = $2::uuid
    AND date BETWEEN ($1::date - INTERVAL '89 days') AND $1::date
)
SELECT
  counts.converter_count AS mature_count,
  CASE WHEN counts.converter_count >= 30 THEN percentiles.roas_p75_raw END AS roas_p75,
  CASE WHEN counts.converter_count >= 10 THEN percentiles.roas_p60_raw END AS roas_p60,
  (SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY recent_total_ratio) FROM recent_ratios WHERE recent_total_ratio IS NOT NULL) AS refresh_ratio_p10,
  counts.refresh_ratio_count,
  (SELECT percentile_cont(0.10) WITHIN GROUP (ORDER BY cumulative_28d_ctr) FROM per_creative WHERE cumulative_28d_ctr IS NOT NULL) AS low_ctr_p10,
  counts.ctr_count,
  CASE WHEN counts.account_cpa_sample_count >= 20 THEN percentiles.cpa_p50_raw END AS account_cpa_p50,
  counts.account_cpa_sample_count,
  meta_aov.aov_mean AS meta_attributed_aov_mean_90d,
  meta_aov.purchase_count AS meta_attributed_aov_purchase_count_90d,
  meta_aov.total_revenue AS meta_attributed_revenue_90d,
  CASE
    WHEN meta_aov.purchase_count >= 20 THEN 'ready'
    WHEN meta_aov.purchase_count >= 5 THEN 'low_sample'
    WHEN meta_aov.purchase_count >= 1 THEN 'unstable'
    ELSE 'unavailable'
  END AS meta_aov_quality,
  percentiles.mature_spend_p50,
  percentiles.mature_spend_p75,
  winner_percentiles.winner_spend_p25,
  winner_percentiles.winner_spend_p50,
  winner_percentiles.winner_purchase_p50,
  percentiles.roas_ratio_p10,
  percentiles.roas_ratio_p25,
  percentiles.roas_ratio_p50,
  percentiles.roas_ratio_p75,
  source_bounds.source_min_date,
  source_bounds.source_max_date,
  source_bounds.source_max_updated_at
FROM counts
CROSS JOIN percentiles
CROSS JOIN winner_percentiles
CROSS JOIN meta_aov
CROSS JOIN source_bounds
`;

const SOURCE_MAX_UPDATED_AT_QUERY = `
SELECT MAX(updated_at) AS source_max_updated_at
FROM meta_creative_daily
WHERE business_ref_id = $1::uuid
  AND date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
`;

// Reads are engine_version-agnostic to avoid table invalidation on ENGINE_VERSION bumps.
// Writes preserve engine_version for provenance.
const READ_ACCOUNT_CALIBRATION_QUERY = `
SELECT
  business_ref_id,
  engine_version,
  mature_creative_count,
  roas_p75,
  roas_p60,
  refresh_ratio_p10,
  low_ctr_p10,
  account_cpa_p50,
  account_cpa_sample_count,
  meta_attributed_aov_mean_90d,
  meta_attributed_aov_purchase_count_90d,
  meta_attributed_revenue_90d,
  meta_aov_quality,
  mature_spend_p50,
  mature_spend_p75,
  winner_spend_p25,
  winner_spend_p50,
  winner_purchase_p50,
  roas_ratio_p10,
  roas_ratio_p25,
  roas_ratio_p50,
  roas_ratio_p75,
  computed_at,
  source_max_updated_at,
  source_max_date,
  as_of_date,
  quality_status
FROM engine_v3_account_calibration_daily
WHERE business_ref_id = $1::uuid
  AND scope_type = $3::text
  AND scope_id = $4::text
  AND creative_format = 'overall'
  AND as_of_date <= $2::date
ORDER BY as_of_date DESC, computed_at DESC
LIMIT 1
`;

const READ_CAMPAIGN_MATURE_CREATIVE_COUNT_QUERY = `
WITH per_creative AS (
  SELECT
    creative_id,
    SUM(spend) AS total_spend,
    SUM(conversions) AS total_purchases,
    SUM(revenue) AS total_revenue
  FROM meta_creative_daily
  WHERE business_ref_id = $1::uuid
    AND campaign_id = $3::text
    AND date BETWEEN ($2::date - INTERVAL '89 days') AND $2::date
    AND objective = 'OUTCOME_SALES'
  GROUP BY creative_id
)
SELECT COUNT(*) AS mature_creative_count
FROM per_creative
WHERE total_purchases >= 1
  AND total_revenue > 0
  AND total_spend > 0
`;

const READ_ACCOUNT_FUNNEL_CALIBRATION_QUERY = `
WITH latest_day AS (
  SELECT MAX(as_of_date) AS as_of_date
  FROM engine_v3_account_calibration_daily
  WHERE business_ref_id = $1::uuid
    AND scope_type = 'account'
    AND scope_id = '*'
    AND as_of_date <= $2::date
)
SELECT
  creative_format,
  ctr_p25,
  ctr_p50,
  cpm_p50,
  cpm_p75,
  thumbstop_p25,
  thumbstop_p50,
  link_to_lpv_p25,
  link_to_lpv_p50,
  link_to_atc_p25,
  link_to_atc_p50,
  lpv_to_atc_p25,
  lpv_to_atc_p50,
  atc_to_ic_p25,
  atc_to_ic_p50,
  ic_to_purchase_p25,
  ic_to_purchase_p50,
  click_to_purchase_p25,
  click_to_purchase_p50,
  funnel_sample_count,
  funnel_quality_status
FROM engine_v3_account_calibration_daily
WHERE business_ref_id = $1::uuid
  AND scope_type = 'account'
  AND scope_id = '*'
  AND as_of_date = (SELECT as_of_date FROM latest_day)
ORDER BY creative_format ASC
`;

const READ_LIFECYCLE_CREATIVE_INPUTS_QUERY = `
WITH lifecycle_rows AS (
  SELECT DISTINCT ON (l.creative_id) l.*
  FROM engine_v3_creative_lifecycle_daily l
  WHERE l.business_ref_id = $1::uuid
    AND l.as_of_date <= $2::date
    AND (NOT $4::boolean OR l.creative_id = ANY($3::text[]))
  ORDER BY l.creative_id, l.as_of_date DESC, l.computed_at DESC
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.creative_name,
    NULLIF(d.payload_json->>'policy_reason', '') AS policy_reason
  FROM meta_creative_daily d
  INNER JOIN lifecycle_rows l ON l.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
target_pack AS (
  SELECT target_roas, break_even_roas
  FROM business_target_packs
  WHERE business_id = $1::uuid
  ORDER BY updated_at DESC
  LIMIT 1
)
SELECT
  l.creative_id,
  latest_meta.creative_name,
  l.campaign_id,
  l.objective,
  l.spend_28d AS spend,
  l.purchases_28d AS purchases,
  l.purchase_value_28d AS purchase_value,
  l.impressions_28d AS impressions,
  l.link_clicks_28d AS link_clicks,
  l.roas_28d AS roas,
  l.cpa_28d AS cpa,
  l.ctr_28d AS ctr,
  l.frequency_28d AS frequency,
  l.spend_7d AS recent_spend,
  l.purchases_7d AS recent_purchases,
  l.roas_7d AS recent_roas,
  l.impressions_7d AS recent_impressions,
  l.effective_status,
  l.age_days,
  l.last_active_date,
  latest_meta.policy_reason,
  l.source_max_updated_at,
  CASE
    WHEN l.source_max_updated_at IS NOT NULL
    THEN FLOOR(EXTRACT(EPOCH FROM (now() - l.source_max_updated_at)) / 3600)
  END AS data_freshness_hours,
  l.fatigue_status,
  l.lifecycle_position,
  l.days_since_peak,
  l.peak_roas_30d,
  l.peak_confidence,
  l.spend_trajectory_30d,
  l.spend_slope_7d,
  l.spend_slope_30d,
  l.roas_slope_7d,
  l.roas_slope_30d,
  l.cpm_28d AS cpm,
  l.outbound_clicks_28d AS outbound_clicks,
  l.landing_page_views_28d AS landing_page_views,
  l.add_to_cart_28d AS add_to_cart,
  l.initiate_checkout_28d AS initiate_checkout,
  l.thumbstop_28d AS thumbstop,
  l.video25_rate_28d AS video25_rate,
  l.video50_rate_28d AS video50_rate,
  l.video75_rate_28d AS video75_rate,
  l.video100_rate_28d AS video100_rate,
  l.quality_ranking,
  l.engagement_rate_ranking,
  l.conversion_rate_ranking,
  l.creative_format,
  target_pack.target_roas,
  target_pack.break_even_roas
FROM lifecycle_rows l
LEFT JOIN latest_meta USING (creative_id)
LEFT JOIN target_pack ON true
ORDER BY l.spend_28d DESC NULLS LAST, l.creative_id ASC
`;

const READ_LIFECYCLE_HEALTH_QUERY = `
SELECT
  MAX(computed_at) AS computed_at,
  MAX(source_max_updated_at) AS source_max_updated_at,
  MAX(as_of_date) AS as_of_date,
  MAX(engine_version) AS engine_version,
  COUNT(*) AS row_count
FROM engine_v3_creative_lifecycle_daily
WHERE business_ref_id = $1::uuid
  AND as_of_date <= $2::date
`;

const READ_LATEST_FUNNEL_DIAGNOSIS_QUERY = `
SELECT
  ctr_28d,
  outbound_click_rate_28d,
  link_to_lpv_rate_28d,
  link_to_atc_rate_28d,
  lpv_to_atc_rate_28d,
  atc_to_ic_rate_28d,
  ic_to_purchase_rate_28d,
  atc_to_purchase_rate_28d,
  click_to_purchase_rate_28d,
  funnel_primary_weak_stage,
  funnel_confidence,
  funnel_evidence,
  creative_responsibility_score
FROM engine_v3_creative_lifecycle_daily
WHERE business_ref_id = $1::uuid
  AND creative_id = $2
  AND as_of_date <= $3::date
ORDER BY as_of_date DESC, computed_at DESC
LIMIT 1
`;

const READ_LATEST_OPERATOR_RESPONSE_QUERY = `
SELECT operator_evidence
FROM engine_v3_decision_events
WHERE business_ref_id = $1::uuid
  AND creative_id = $2
  AND event_type = 'operator_action'
  AND operator_evidence IS NOT NULL
  AND event_date <= $3::date
ORDER BY event_date DESC, created_at DESC
LIMIT 1
`;

const READ_BUSINESS_TARGET_PACK_QUERY = `
SELECT
  target_cpa,
  target_roas,
  break_even_cpa,
  break_even_roas,
  aov_assumption,
  default_risk_posture
FROM business_target_packs
WHERE business_id = $1::uuid
ORDER BY updated_at DESC
LIMIT 1
`;

const READ_DECISION_CALIBRATION_PROFILE_QUERY = `
SELECT
  engine_preset_label,
  zero_conv_burner_multiplier,
  cut_candidate_multiplier,
  sustained_loser_multiplier,
  hard_cut_multiplier,
  scale_evidence_multiplier,
  scale_purchase_multiplier,
  winner_memory_multiplier,
  recent_sample_multiplier,
  weak_funnel_rate_multiplier,
  attribution_aov_adjustment_multiplier
FROM business_decision_calibration_profiles
WHERE business_id = $1::uuid
  AND channel = $2
  AND objective_family = $3
ORDER BY
  CASE WHEN bid_regime = 'open' THEN 0 WHEN bid_regime = 'unknown' THEN 1 ELSE 2 END,
  CASE WHEN archetype = 'default' THEN 0 ELSE 1 END,
  updated_at DESC
LIMIT 1
`;

function toNumberOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toIntegerOrNull(value: unknown): number | null {
  const number = toNumberOrNull(value);
  return number === null ? null : Math.floor(number);
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toEngineRiskPreset(value: unknown): EngineRiskPreset | null {
  const text = toStringOrNull(value);
  return text === "aggressive" || text === "balanced" || text === "conservative"
    ? text
    : null;
}

function toMetaAovQuality(value: unknown): MetaAovQuality | null {
  const text = toStringOrNull(value);
  return text === "unavailable" ||
    text === "unstable" ||
    text === "low_sample" ||
    text === "ready"
    ? text
    : null;
}

function toIsoDateOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return formatDateOnly(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const isoDatePrefix = /^\d{4}-\d{2}-\d{2}/.exec(trimmed)?.[0] ?? null;
    if (isoDatePrefix) return isoDatePrefix;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime())
      ? null
      : parsed.toISOString().slice(0, 10);
  }
  return null;
}

function formatDateOnly(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toIsoTimestampOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toCampaignObjective(value: unknown): CampaignObjective | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return CAMPAIGN_OBJECTIVES.has(text as CampaignObjective)
    ? (text as CampaignObjective)
    : null;
}

function toEffectiveStatus(value: unknown): EffectiveStatus {
  const text = toStringOrNull(value)?.toUpperCase();
  if (text === undefined || text === null) return null;
  return EFFECTIVE_STATUSES.has(text as NonNullable<EffectiveStatus>)
    ? (text as NonNullable<EffectiveStatus>)
    : null;
}

function toFatigueStatus(value: unknown): CreativeInput["fatigueStatus"] {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return FATIGUE_STATUSES.has(text as NonNullable<CreativeInput["fatigueStatus"]>)
    ? (text as NonNullable<CreativeInput["fatigueStatus"]>)
    : null;
}

function toLifecyclePosition(value: unknown): LifecyclePosition | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return LIFECYCLE_POSITIONS.has(text as LifecyclePosition)
    ? (text as LifecyclePosition)
    : null;
}

function toSpendTrajectory(value: unknown): SpendTrajectory | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return SPEND_TRAJECTORIES.has(text as SpendTrajectory)
    ? (text as SpendTrajectory)
    : null;
}

function normalizeToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function toMetaRanking(value: unknown): MetaRanking | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  const normalized = normalizeToken(text);
  if (normalized.startsWith("above_average")) return "above_average";
  if (normalized.startsWith("below_average")) return "below_average";
  if (META_RANKINGS.has(normalized as MetaRanking)) {
    return normalized as MetaRanking;
  }
  return null;
}

function toCreativeFormat(value: unknown): CreativeFormat | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  const normalized = normalizeToken(text);
  if (CREATIVE_FORMATS.has(normalized as CreativeFormat)) {
    return normalized as CreativeFormat;
  }
  if (normalized.includes("carousel")) return "carousel";
  if (normalized.includes("catalog")) return "catalog";
  if (normalized.includes("video")) return "video";
  if (normalized.includes("image") || normalized.includes("photo")) {
    return "image";
  }
  return "other";
}

function toFunnelStage(value: unknown): FunnelStage | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return FUNNEL_STAGES.has(text as FunnelStage) ? (text as FunnelStage) : null;
}

function toOperatorResponseType(value: unknown): OperatorResponseType | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return OPERATOR_RESPONSE_TYPES.has(text as OperatorResponseType)
    ? (text as OperatorResponseType)
    : null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function toRecord(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") {
    try {
      return toRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const text = toStringOrNull(item);
      return text === null ? [] : [text];
    });
  }
  if (typeof value === "string") {
    try {
      return toStringArray(JSON.parse(value) as unknown);
    } catch {
      const text = value.trim();
      return text ? [text] : [];
    }
  }
  return [];
}

function mapFunnelDiagnosisRow(
  row: FunnelDiagnosisTableRow | undefined,
): FunnelDiagnosis | null {
  if (!row) return null;
  const primaryWeakStage = toFunnelStage(row.funnel_primary_weak_stage);
  if (primaryWeakStage === null) return null;

  return {
    primaryWeakStage,
    creativeResponsible:
      (toNumberOrNull(row.creative_responsibility_score) ?? 0) > 0,
    confidence: toNumberOrNull(row.funnel_confidence) ?? 0,
    evidence: toStringArray(row.funnel_evidence),
    rates: {
      ctr: toNumberOrNull(row.ctr_28d),
      outboundClickRate: toNumberOrNull(row.outbound_click_rate_28d),
      linkToLpvRate: toNumberOrNull(row.link_to_lpv_rate_28d),
      linkToAtcRate: toNumberOrNull(row.link_to_atc_rate_28d),
      lpvToAtcRate: toNumberOrNull(row.lpv_to_atc_rate_28d),
      atcToIcRate: toNumberOrNull(row.atc_to_ic_rate_28d),
      icToPurchaseRate: toNumberOrNull(row.ic_to_purchase_rate_28d),
      atcToPurchaseRate: toNumberOrNull(row.atc_to_purchase_rate_28d),
      clickToPurchaseRate: toNumberOrNull(row.click_to_purchase_rate_28d),
    },
  };
}

function mapOperatorResponseRow(
  row: OperatorResponseEventRow | undefined,
): OperatorResponseResult | null {
  if (!row) return null;
  const evidenceRecord = toRecord(row.operator_evidence);
  const responseType = toOperatorResponseType(evidenceRecord.response_type);
  if (responseType === null) return null;
  const signals = toRecord(evidenceRecord.signals);
  const promoteLifecyclePosition =
    toStringOrNull(evidenceRecord.lifecycle_promotion) === "past_peak_inaction"
      ? "past_peak_inaction"
      : undefined;

  return {
    responseType,
    decisionRecommendedAt: toIsoDateOrNull(
      evidenceRecord.decision_recommended_at,
    ),
    operatorResponseDetectedAt: toIsoTimestampOrNull(
      evidenceRecord.operator_response_detected_at,
    ),
    confidence: toNumberOrNull(evidenceRecord.confidence) ?? 0,
    evidence: toStringArray(evidenceRecord.evidence),
    ...(promoteLifecyclePosition ? { promoteLifecyclePosition } : {}),
    signals: {
      spendSlope7d: toNumberOrNull(signals.spendSlope7d),
      budgetChangeAmount: toNumberOrNull(signals.budgetChangeAmount),
      actionJournalReceiptCount:
        toIntegerOrNull(signals.actionJournalReceiptCount) ?? 0,
      statusChanged: toBoolean(signals.statusChanged),
      roasDecayPct: toNumberOrNull(signals.roasDecayPct),
      frequencyRosePct: toNumberOrNull(signals.frequencyRosePct),
    },
  };
}

function toHistoricalWindow(
  row: CreativeHydrationRow,
  prefix: string,
): HistoricalWindow | null {
  const rowCount = toNumberOrNull(row[`${prefix}_row_count`]) ?? 0;
  if (rowCount <= 0) return null;

  return {
    spend: toNumberOrNull(row[`${prefix}_spend`]) ?? 0,
    ctr: toNumberOrNull(row[`${prefix}_ctr`]) ?? 0,
    roas: toNumberOrNull(row[`${prefix}_roas`]) ?? 0,
    clickToPurchaseRate:
      toNumberOrNull(row[`${prefix}_click_to_purchase_rate`]) ?? 0,
    purchases: toNumberOrNull(row[`${prefix}_purchases`]) ?? 0,
  };
}

function calculateClickToPurchaseRate(input: {
  purchases: number;
  linkClicks: number | null;
}) {
  if (input.linkClicks === null || input.linkClicks <= 0) return null;
  return input.purchases / input.linkClicks;
}

function mapCreativeHydrationRow(input: {
  row: CreativeHydrationRow;
  businessId: string;
}): CreativeInput | null {
  const creativeId = toStringOrNull(input.row.creative_id);
  if (creativeId === null) return null;

  const spend = toNumberOrNull(input.row.spend) ?? 0;
  const purchases = toNumberOrNull(input.row.purchases) ?? 0;
  const linkClicks = toNumberOrNull(input.row.link_clicks);
  const ctr = toNumberOrNull(input.row.ctr);
  const roas = toNumberOrNull(input.row.roas);
  const frequency = toNumberOrNull(input.row.frequency);
  const targetRoas = toNumberOrNull(input.row.target_roas);
  const breakevenRoas = toNumberOrNull(input.row.break_even_roas);
  const fatigue = computeFatigue({
    ctr,
    roas,
    clickToPurchaseRate: calculateClickToPurchaseRate({
      purchases,
      linkClicks,
    }),
    effectiveTargetRoas: targetRoas,
    breakevenRoas,
    historicalWindows: {
      last14: toHistoricalWindow(input.row, "last14"),
      last30: toHistoricalWindow(input.row, "last30"),
      last90: toHistoricalWindow(input.row, "last90"),
      allHistory: toHistoricalWindow(input.row, "all_history"),
    },
    spendConcentration: null,
    frequency,
    benchmarkRoasStatus: null,
    benchmarkClickToPurchaseStatus: null,
  });

  return {
    creativeId,
    creativeName: toStringOrNull(input.row.creative_name),
    businessId: input.businessId,
    campaignId: toStringOrNull(input.row.campaign_id),
    objective: toCampaignObjective(input.row.objective),
    spend,
    purchases,
    purchaseValue: toNumberOrNull(input.row.purchase_value),
    impressions: toNumberOrNull(input.row.impressions),
    linkClicks,
    roas,
    cpa: toNumberOrNull(input.row.cpa),
    ctr,
    frequency,
    recent7dSpend: toNumberOrNull(input.row.recent_spend),
    recent7dPurchases: toNumberOrNull(input.row.recent_purchases),
    recent7dRoas: toNumberOrNull(input.row.recent_roas),
    recent7dImpressions: toNumberOrNull(input.row.recent_impressions),
    effectiveStatus: toEffectiveStatus(input.row.effective_status),
    ageDays: toIntegerOrNull(input.row.age_days),
    lastSpendAt: toIsoDateOrNull(input.row.last_spend_date),
    policyReason: toStringOrNull(input.row.policy_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: fatigue.status,
    targetRoas,
    breakevenRoas,
    lifecyclePosition: null,
    daysSincePeak: null,
    peakRoas30d: null,
    peakConfidence: null,
    spendTrajectory30d: null,
    spendSlope7d: null,
    spendSlope30d: null,
    roasSlope7d: null,
    roasSlope30d: null,
    cpm: toNumberOrNull(input.row.cpm),
    outboundClicks: toIntegerOrNull(input.row.outbound_clicks),
    landingPageViews: toIntegerOrNull(input.row.landing_page_views),
    addToCart: toIntegerOrNull(input.row.add_to_cart),
    initiateCheckout: toIntegerOrNull(input.row.initiate_checkout),
    thumbstop: toNumberOrNull(input.row.thumbstop),
    video25Rate: toNumberOrNull(input.row.video25_rate),
    video50Rate: toNumberOrNull(input.row.video50_rate),
    video75Rate: toNumberOrNull(input.row.video75_rate),
    video100Rate: toNumberOrNull(input.row.video100_rate),
    qualityRanking: toMetaRanking(input.row.quality_ranking),
    engagementRateRanking: toMetaRanking(input.row.engagement_rate_ranking),
    conversionRateRanking: toMetaRanking(input.row.conversion_rate_ranking),
    creativeFormat: toCreativeFormat(input.row.creative_format),
  };
}

function mapLifecycleHydrationRow(input: {
  row: LifecycleTableHydrationRow;
  businessId: string;
}): CreativeInput | null {
  const creativeId = toStringOrNull(input.row.creative_id);
  if (creativeId === null) return null;

  const sourceMaxUpdatedAt = toIsoTimestampOrNull(
    input.row.source_max_updated_at,
  );
  if (
    sourceMaxUpdatedAt === null ||
    isOlderThanHours(sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)
  ) {
    return null;
  }

  return {
    creativeId,
    creativeName: toStringOrNull(input.row.creative_name),
    businessId: input.businessId,
    campaignId: toStringOrNull(input.row.campaign_id),
    objective: toCampaignObjective(input.row.objective),
    spend: toNumberOrNull(input.row.spend) ?? 0,
    purchases: toNumberOrNull(input.row.purchases) ?? 0,
    purchaseValue: toNumberOrNull(input.row.purchase_value),
    impressions: toNumberOrNull(input.row.impressions),
    linkClicks: toNumberOrNull(input.row.link_clicks),
    roas: toNumberOrNull(input.row.roas),
    cpa: toNumberOrNull(input.row.cpa),
    ctr: toNumberOrNull(input.row.ctr),
    frequency: toNumberOrNull(input.row.frequency),
    recent7dSpend: toNumberOrNull(input.row.recent_spend),
    recent7dPurchases: toNumberOrNull(input.row.recent_purchases),
    recent7dRoas: toNumberOrNull(input.row.recent_roas),
    recent7dImpressions: toNumberOrNull(input.row.recent_impressions),
    effectiveStatus: toEffectiveStatus(input.row.effective_status),
    ageDays: toIntegerOrNull(input.row.age_days),
    lastSpendAt: toIsoDateOrNull(input.row.last_active_date),
    policyReason: toStringOrNull(input.row.policy_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: toFatigueStatus(input.row.fatigue_status),
    targetRoas: toNumberOrNull(input.row.target_roas),
    breakevenRoas: toNumberOrNull(input.row.break_even_roas),
    lifecyclePosition: toLifecyclePosition(input.row.lifecycle_position),
    daysSincePeak: toIntegerOrNull(input.row.days_since_peak),
    peakRoas30d: toNumberOrNull(input.row.peak_roas_30d),
    peakConfidence: toNumberOrNull(input.row.peak_confidence),
    spendTrajectory30d: toSpendTrajectory(input.row.spend_trajectory_30d),
    spendSlope7d: toNumberOrNull(input.row.spend_slope_7d),
    spendSlope30d: toNumberOrNull(input.row.spend_slope_30d),
    roasSlope7d: toNumberOrNull(input.row.roas_slope_7d),
    roasSlope30d: toNumberOrNull(input.row.roas_slope_30d),
    cpm: toNumberOrNull(input.row.cpm),
    outboundClicks: toIntegerOrNull(input.row.outbound_clicks),
    landingPageViews: toIntegerOrNull(input.row.landing_page_views),
    addToCart: toIntegerOrNull(input.row.add_to_cart),
    initiateCheckout: toIntegerOrNull(input.row.initiate_checkout),
    thumbstop: toNumberOrNull(input.row.thumbstop),
    video25Rate: toNumberOrNull(input.row.video25_rate),
    video50Rate: toNumberOrNull(input.row.video50_rate),
    video75Rate: toNumberOrNull(input.row.video75_rate),
    video100Rate: toNumberOrNull(input.row.video100_rate),
    qualityRanking: toMetaRanking(input.row.quality_ranking),
    engagementRateRanking: toMetaRanking(input.row.engagement_rate_ranking),
    conversionRateRanking: toMetaRanking(input.row.conversion_rate_ranking),
    creativeFormat: toCreativeFormat(input.row.creative_format),
  };
}

function gatePercentile(input: {
  value: number | null;
  count: number;
  minimumCount: number;
}) {
  return input.count >= input.minimumCount ? input.value : null;
}

function zeroAccountCalibration(
  businessId: string,
  computedAt: string,
): AccountCalibration {
  return {
    businessId,
    computedAt,
    matureCreativeCount: 0,
    roasP75: null,
    roasP60: null,
    refreshRatioP10: null,
    lowCtrP10: null,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    metaAttributedAovMean90d: null,
    metaAttributedAovPurchaseCount90d: 0,
    metaAttributedRevenue90d: 0,
    matureSpendP50: null,
    matureSpendP75: null,
    winnerSpendP25: null,
    winnerSpendP50: null,
    winnerPurchaseP50: null,
    roasRatioP10: null,
    roasRatioP25: null,
    roasRatioP50: null,
    roasRatioP75: null,
    metaAovQuality: "unavailable",
  };
}

function zeroAccountFunnelCalibration(): AccountFunnelCalibration {
  return { byFormat: {} };
}

function toFunnelQualityStatus(
  value: unknown,
  sampleSize: number,
): FormatFunnelBaseline["qualityStatus"] {
  const text = toStringOrNull(value);
  if (
    text === "ready" ||
    text === "low_sample" ||
    text === "insufficient"
  ) {
    return text;
  }
  if (sampleSize >= 30) return "ready";
  if (sampleSize >= 10) return "low_sample";
  return "insufficient";
}

function mapFunnelCalibrationRow(
  row: FunnelCalibrationTableRow,
): FormatFunnelBaseline | null {
  const creativeFormat = toStringOrNull(row.creative_format);
  if (creativeFormat === null) return null;

  const sampleSize = toIntegerOrNull(row.funnel_sample_count) ?? 0;
  return {
    creativeFormat,
    ctrP25: toNumberOrNull(row.ctr_p25),
    ctrP50: toNumberOrNull(row.ctr_p50),
    cpmP50: toNumberOrNull(row.cpm_p50),
    cpmP75: toNumberOrNull(row.cpm_p75),
    thumbstopP25: toNumberOrNull(row.thumbstop_p25),
    thumbstopP50: toNumberOrNull(row.thumbstop_p50),
    linkToLpvP25: toNumberOrNull(row.link_to_lpv_p25),
    linkToLpvP50: toNumberOrNull(row.link_to_lpv_p50),
    linkToAtcP25: toNumberOrNull(row.link_to_atc_p25),
    linkToAtcP50: toNumberOrNull(row.link_to_atc_p50),
    lpvToAtcP25: toNumberOrNull(row.lpv_to_atc_p25),
    lpvToAtcP50: toNumberOrNull(row.lpv_to_atc_p50),
    atcToIcP25: toNumberOrNull(row.atc_to_ic_p25),
    atcToIcP50: toNumberOrNull(row.atc_to_ic_p50),
    icToPurchaseP25: toNumberOrNull(row.ic_to_purchase_p25),
    icToPurchaseP50: toNumberOrNull(row.ic_to_purchase_p50),
    clickToPurchaseP25: toNumberOrNull(row.click_to_purchase_p25),
    clickToPurchaseP50: toNumberOrNull(row.click_to_purchase_p50),
    sampleSize,
    qualityStatus: toFunnelQualityStatus(row.funnel_quality_status, sampleSize),
  };
}

function isOlderThanHours(timestamp: string, hours: number) {
  const parsed = new Date(timestamp).getTime();
  if (!Number.isFinite(parsed)) return true;
  return Date.now() - parsed > hours * 3_600_000;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function buildWarehouseDataLayerHealth(input: {
  asOfDate: string | null;
  computedAt: string | null;
  sourceMaxUpdatedAt: string | null;
  fallbackMode: FallbackMode;
  note?: string | null;
  staleTierOverride?: StaleTier;
}): DataLayerHealth {
  const health = buildDataLayerHealth(input);
  if (input.staleTierOverride) {
    return { ...health, staleTier: input.staleTierOverride };
  }
  if (input.sourceMaxUpdatedAt === null) {
    return {
      ...health,
      staleTier: "warning",
      note: input.note ?? "unknown source freshness for warehouse-backed layer",
    };
  }
  return health;
}

/**
 * Production warehouse implementation backed by meta_creative_daily and
 * business_target_packs. The engine still consumes the same CreativeInput
 * contract as MockDataSource.
 */
export class WarehouseDataSource implements CreativeDecisionDataSource {
  private lastCalibrationMetadata: CalibrationReadMetadata | null = null;

  private async computeCreativeInputsViaRuntimeSql(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const creativeIds = input.creativeIds ?? [];
    if (input.creativeIds && input.creativeIds.length === 0) return [];

    const rows = await getDb().query<CreativeHydrationRow>(
      HYDRATE_CREATIVE_INPUTS_QUERY,
      [input.businessId, input.asOf, creativeIds, input.creativeIds != null],
    );

    return rows
      .map((row) =>
        mapCreativeHydrationRow({
          row,
          businessId: input.businessId,
        }),
      )
      .filter((creative): creative is CreativeInput => creative !== null);
  }

  private async readCreativeInputsFromLifecycleTable(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const creativeIds = input.creativeIds ?? [];
    if (input.creativeIds && input.creativeIds.length === 0) return [];

    let rows: LifecycleTableHydrationRow[];
    try {
      rows = await getDb().query<LifecycleTableHydrationRow>(
        READ_LIFECYCLE_CREATIVE_INPUTS_QUERY,
        [input.businessId, input.asOf, creativeIds, input.creativeIds != null],
      );
    } catch {
      return [];
    }

    return rows
      .map((row) =>
        mapLifecycleHydrationRow({
          row,
          businessId: input.businessId,
        }),
      )
      .filter((creative): creative is CreativeInput => creative !== null);
  }

  async getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null> {
    const fromTable = await this.readCreativeInputsFromLifecycleTable({
      businessId: input.businessId,
      asOf: input.asOf,
      creativeIds: [input.creativeId],
    });
    if (fromTable[0]) return fromTable[0];

    const results = await this.computeCreativeInputsViaRuntimeSql({
      businessId: input.businessId,
      asOf: input.asOf,
      creativeIds: [input.creativeId],
    });
    return results[0] ?? null;
  }

  async getAccountCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountCalibration> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
      "account",
      "*",
    );
    if (precomputed.calibration !== null) {
      this.lastCalibrationMetadata = precomputed.metadata;
      return precomputed.calibration;
    }

    return this.computeCalibrationViaRuntimeSql(
      input,
      precomputed.note,
      precomputed.staleTierOverride,
    );
  }

  async getCampaignCalibration(input: {
    businessId: string;
    asOf: string;
    campaignId: string;
  }): Promise<CampaignCalibrationLookup> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
      "campaign",
      input.campaignId,
    );
    if (precomputed.calibration !== null) {
      return {
        calibration: precomputed.calibration,
        matureCreativeCount: precomputed.calibration.matureCreativeCount,
      };
    }

    return {
      calibration: null,
      matureCreativeCount: await this.readCampaignMatureCreativeCount(input),
    };
  }

  async getAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
  }): Promise<AccountFunnelCalibration> {
    let rows: FunnelCalibrationTableRow[];
    try {
      rows = await getDb().query<FunnelCalibrationTableRow>(
        READ_ACCOUNT_FUNNEL_CALIBRATION_QUERY,
        [input.businessId, input.asOf],
      );
    } catch {
      return zeroAccountFunnelCalibration();
    }

    const byFormat: Record<string, FormatFunnelBaseline> = {};
    for (const row of rows) {
      const baseline = mapFunnelCalibrationRow(row);
      if (baseline !== null) {
        byFormat[baseline.creativeFormat] = baseline;
      }
    }

    return { byFormat };
  }

  private async computeCalibrationViaRuntimeSql(
    input: {
      businessId: string;
      asOf: string;
    },
    fallbackNote: string,
    staleTierOverride?: StaleTier,
  ): Promise<AccountCalibration> {
    const computedAt = new Date().toISOString();
    let row: CalibrationRow | undefined;
    try {
      [row] = await getDb().query<CalibrationRow>(ACCOUNT_CALIBRATION_QUERY, [
        input.asOf,
        input.businessId,
      ]);
    } catch (error) {
      const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
        input.businessId,
        input.asOf,
      ).catch(() => null);
      this.lastCalibrationMetadata = {
        businessId: input.businessId,
        requestedAsOf: input.asOf,
        asOfDate: input.asOf,
        computedAt,
        sourceMaxUpdatedAt,
        fallbackMode: "insufficient",
        note: `Calibration unavailable; runtime SQL failed after precomputed fallback (${errorMessage(error)})`,
        staleTierOverride,
      };
      return zeroAccountCalibration(input.businessId, computedAt);
    }

    const matureCount = toIntegerOrNull(row?.mature_count) ?? 0;
    const refreshRatioCount = toIntegerOrNull(row?.refresh_ratio_count) ?? 0;
    const ctrCount = toIntegerOrNull(row?.ctr_count) ?? 0;
    const sourceMaxUpdatedAt = toIsoTimestampOrNull(
      row?.source_max_updated_at,
    );
    const sourceMaxDate = toIsoDateOrNull(row?.source_max_date);

    const calibration: AccountCalibration = {
      businessId: input.businessId,
      computedAt,
      matureCreativeCount: matureCount,
      roasP75: gatePercentile({
        value: toNumberOrNull(row?.roas_p75),
        count: matureCount,
        minimumCount: 30,
      }),
      roasP60: gatePercentile({
        value: toNumberOrNull(row?.roas_p60),
        count: matureCount,
        minimumCount: 10,
      }),
      refreshRatioP10: gatePercentile({
        value: toNumberOrNull(row?.refresh_ratio_p10),
        count: refreshRatioCount,
        minimumCount: 20,
      }),
      lowCtrP10: gatePercentile({
        value: toNumberOrNull(row?.low_ctr_p10),
        count: ctrCount,
        minimumCount: 20,
      }),
      accountCpaP50: toNumberOrNull(row?.account_cpa_p50),
      accountCpaSampleCount:
        toIntegerOrNull(row?.account_cpa_sample_count) ?? 0,
      metaAttributedAovMean90d: toNumberOrNull(
        row?.meta_attributed_aov_mean_90d,
      ),
      metaAttributedAovPurchaseCount90d:
        toIntegerOrNull(row?.meta_attributed_aov_purchase_count_90d) ?? 0,
      metaAttributedRevenue90d:
        toNumberOrNull(row?.meta_attributed_revenue_90d) ?? 0,
      matureSpendP50: toNumberOrNull(row?.mature_spend_p50),
      matureSpendP75: toNumberOrNull(row?.mature_spend_p75),
      winnerSpendP25: toNumberOrNull(row?.winner_spend_p25),
      winnerSpendP50: toNumberOrNull(row?.winner_spend_p50),
      winnerPurchaseP50: toNumberOrNull(row?.winner_purchase_p50),
      roasRatioP10: toNumberOrNull(row?.roas_ratio_p10),
      roasRatioP25: toNumberOrNull(row?.roas_ratio_p25),
      roasRatioP50: toNumberOrNull(row?.roas_ratio_p50),
      roasRatioP75: toNumberOrNull(row?.roas_ratio_p75),
      metaAovQuality:
        toMetaAovQuality(row?.meta_aov_quality) ??
        classifyMetaAovQuality(
          toIntegerOrNull(row?.meta_attributed_aov_purchase_count_90d) ?? 0,
        ),
    };
    this.lastCalibrationMetadata = {
      businessId: input.businessId,
      requestedAsOf: input.asOf,
      asOfDate: sourceMaxDate ?? input.asOf,
      computedAt,
      sourceMaxUpdatedAt,
      fallbackMode: "runtime_sql",
      note: fallbackNote,
      staleTierOverride,
    };
    return calibration;
  }

  private async readCalibrationFromTable(
    businessId: string,
    asOf: string,
    scopeType: "account" | "campaign",
    scopeId: string,
  ): Promise<{
    calibration: AccountCalibration | null;
    metadata: CalibrationReadMetadata | null;
    note: string;
    staleTierOverride?: StaleTier;
  }> {
    let row: CalibrationTableRow | undefined;
    try {
      [row] = await getDb().query<CalibrationTableRow>(
        READ_ACCOUNT_CALIBRATION_QUERY,
        [businessId, asOf, scopeType, scopeId],
      );
    } catch (error) {
      return {
        calibration: null,
        metadata: null,
        note: `Runtime SQL fallback (precomputed calibration lookup failed for asOf ${asOf}: ${errorMessage(error)})`,
      };
    }

    if (!row) {
      return {
        calibration: null,
        metadata: null,
        note: "no precomputed row available; runtime fallback in use",
        staleTierOverride: "warning",
      };
    }

    const sourceMaxUpdatedAt = toIsoTimestampOrNull(
      row.source_max_updated_at,
    );
    const computedAt = toIsoTimestampOrNull(row.computed_at);
    const asOfDate = toIsoDateOrNull(row.as_of_date) ?? asOf;
    const engineVersion = toStringOrNull(row.engine_version) ?? "unknown";
    if (sourceMaxUpdatedAt === null) {
      return {
        calibration: null,
        metadata: {
          businessId,
          requestedAsOf: asOf,
          asOfDate,
          computedAt,
          sourceMaxUpdatedAt,
          fallbackMode: "runtime_sql",
          note: "unknown source freshness for warehouse-backed layer",
          staleTierOverride: "warning",
        },
        note: "unknown source freshness for warehouse-backed layer",
        staleTierOverride: "warning",
      };
    }

    if (isOlderThanHours(sourceMaxUpdatedAt, STALE_TIER_WARNING_MAX_HOURS)) {
      return {
        calibration: null,
        metadata: null,
        note: `Runtime SQL fallback (precomputed calibration stale for asOf ${asOf})`,
      };
    }

    const metadata: CalibrationReadMetadata = {
      businessId,
      requestedAsOf: asOf,
      asOfDate,
      computedAt,
      sourceMaxUpdatedAt,
      fallbackMode: "precomputed",
      note: `computed by engine ${engineVersion}`,
    };

    return {
      calibration: {
        businessId: toStringOrNull(row.business_ref_id) ?? businessId,
        computedAt: computedAt ?? new Date().toISOString(),
        matureCreativeCount:
          toIntegerOrNull(row.mature_creative_count) ?? 0,
        roasP75: toNumberOrNull(row.roas_p75),
        roasP60: toNumberOrNull(row.roas_p60),
        refreshRatioP10: toNumberOrNull(row.refresh_ratio_p10),
        lowCtrP10: toNumberOrNull(row.low_ctr_p10),
        accountCpaP50: toNumberOrNull(row.account_cpa_p50),
        accountCpaSampleCount:
          toIntegerOrNull(row.account_cpa_sample_count) ?? 0,
        metaAttributedAovMean90d: toNumberOrNull(
          row.meta_attributed_aov_mean_90d,
        ),
        metaAttributedAovPurchaseCount90d:
          toIntegerOrNull(row.meta_attributed_aov_purchase_count_90d) ?? 0,
        metaAttributedRevenue90d:
          toNumberOrNull(row.meta_attributed_revenue_90d) ?? 0,
        matureSpendP50: toNumberOrNull(row.mature_spend_p50),
        matureSpendP75: toNumberOrNull(row.mature_spend_p75),
        winnerSpendP25: toNumberOrNull(row.winner_spend_p25),
        winnerSpendP50: toNumberOrNull(row.winner_spend_p50),
        winnerPurchaseP50: toNumberOrNull(row.winner_purchase_p50),
        roasRatioP10: toNumberOrNull(row.roas_ratio_p10),
        roasRatioP25: toNumberOrNull(row.roas_ratio_p25),
        roasRatioP50: toNumberOrNull(row.roas_ratio_p50),
        roasRatioP75: toNumberOrNull(row.roas_ratio_p75),
        metaAovQuality:
          toMetaAovQuality(row.meta_aov_quality) ??
          classifyMetaAovQuality(
            toIntegerOrNull(row.meta_attributed_aov_purchase_count_90d) ?? 0,
          ),
      },
      metadata,
      note: "",
    };
  }

  private async readCampaignMatureCreativeCount(input: {
    businessId: string;
    asOf: string;
    campaignId: string;
  }): Promise<number | null> {
    try {
      const [row] = await getDb().query<
        Record<string, unknown> & { mature_creative_count: unknown }
      >(READ_CAMPAIGN_MATURE_CREATIVE_COUNT_QUERY, [
        input.businessId,
        input.asOf,
        input.campaignId,
      ]);
      return toIntegerOrNull(row?.mature_creative_count);
    } catch {
      return null;
    }
  }

  async listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const fromTable = await this.readCreativeInputsFromLifecycleTable(input);
    if (fromTable.length > 0) return fromTable;

    return this.computeCreativeInputsViaRuntimeSql(input);
  }

  async getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth> {
    const calibration = await this.buildCalibrationDataLayerHealth(
      input.businessId,
      input.asOf,
    );
    const lifecycle = await this.buildLifecycleDataLayerHealth(
      input.businessId,
      input.asOf,
    );
    const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
      input.businessId,
      input.asOf,
    );
    const decisions = buildDataLayerHealth({
      asOfDate: input.asOf,
      computedAt: new Date().toISOString(),
      sourceMaxUpdatedAt,
      fallbackMode: "runtime_sql",
      note: "Decision snapshots are not populated until Phase 3.5; runtime decisions are computed on request",
    });

    return composeDataHealth({
      calibration,
      lifecycle,
      decisions,
    });
  }

  async getLatestFunnelDiagnosis(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<FunnelDiagnosis | null> {
    const [row] = await getDb().query<FunnelDiagnosisTableRow>(
      READ_LATEST_FUNNEL_DIAGNOSIS_QUERY,
      [input.businessId, input.creativeId, input.asOf],
    );
    return mapFunnelDiagnosisRow(row);
  }

  async getLatestOperatorResponse(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<OperatorResponseResult | null> {
    const [row] = await getDb().query<OperatorResponseEventRow>(
      READ_LATEST_OPERATOR_RESPONSE_QUERY,
      [input.businessId, input.creativeId, input.asOf],
    );
    return mapOperatorResponseRow(row);
  }

  private async buildCalibrationDataLayerHealth(
    businessId: string,
    asOf: string,
  ): Promise<DataLayerHealth> {
    const last = this.lastCalibrationMetadata;
    if (last?.businessId === businessId && last.requestedAsOf === asOf) {
      return buildWarehouseDataLayerHealth({
        asOfDate: last.asOfDate,
        computedAt: last.computedAt,
        sourceMaxUpdatedAt: last.sourceMaxUpdatedAt,
        fallbackMode: last.fallbackMode,
        note: last.note,
        staleTierOverride: last.staleTierOverride,
      });
    }

    const precomputed = await this.readCalibrationFromTable(
      businessId,
      asOf,
      "account",
      "*",
    );
    if (precomputed.metadata !== null) {
      return buildWarehouseDataLayerHealth({
        asOfDate: precomputed.metadata.asOfDate,
        computedAt: precomputed.metadata.computedAt,
        sourceMaxUpdatedAt: precomputed.metadata.sourceMaxUpdatedAt,
        fallbackMode: precomputed.metadata.fallbackMode,
        note: precomputed.metadata.note,
        staleTierOverride: precomputed.metadata.staleTierOverride,
      });
    }

    const sourceMaxUpdatedAt = await this.fetchSourceMaxUpdatedAt(
      businessId,
      asOf,
    );
    const fallbackMode: FallbackMode =
      sourceMaxUpdatedAt === null ? "insufficient" : "runtime_sql";

    return buildWarehouseDataLayerHealth({
      asOfDate: asOf,
      computedAt: new Date().toISOString(),
      sourceMaxUpdatedAt,
      fallbackMode,
      note: precomputed.note,
      staleTierOverride: precomputed.staleTierOverride,
    });
  }

  private async buildLifecycleDataLayerHealth(
    businessId: string,
    asOf: string,
  ): Promise<DataLayerHealth> {
    let row: LifecycleHealthRow | undefined;
    try {
      [row] = await getDb().query<LifecycleHealthRow>(
        READ_LIFECYCLE_HEALTH_QUERY,
        [businessId, asOf],
      );
    } catch (error) {
      return buildWarehouseDataLayerHealth({
        asOfDate: asOf,
        computedAt: new Date().toISOString(),
        sourceMaxUpdatedAt: null,
        fallbackMode: "runtime_sql",
        note: `Lifecycle unavailable; runtime SQL fallback (${errorMessage(error)})`,
      });
    }

    const rowCount = toIntegerOrNull(row?.row_count) ?? 0;
    if (rowCount === 0) {
      return buildWarehouseDataLayerHealth({
        asOfDate: asOf,
        computedAt: new Date().toISOString(),
        sourceMaxUpdatedAt: null,
        fallbackMode: "runtime_sql",
        note: "no precomputed row available; runtime fallback in use",
        staleTierOverride: "warning",
      });
    }

    return buildWarehouseDataLayerHealth({
      asOfDate: toIsoDateOrNull(row?.as_of_date) ?? asOf,
      computedAt: toIsoTimestampOrNull(row?.computed_at),
      sourceMaxUpdatedAt: toIsoTimestampOrNull(row?.source_max_updated_at),
      fallbackMode: "precomputed",
      note: null,
    });
  }

  private async fetchSourceMaxUpdatedAt(
    businessId: string,
    asOf: string,
  ): Promise<string | null> {
    const [row] = await getDb().query<SourceMaxUpdatedAtRow>(
      SOURCE_MAX_UPDATED_AT_QUERY,
      [businessId, asOf],
    );

    return toIsoTimestampOrNull(row?.source_max_updated_at);
  }

  async getBusinessTargetPack(input: {
    businessId: string;
  }): Promise<BusinessTargetPack | null> {
    let row: BusinessTargetPackRow | undefined;
    try {
      [row] = await getDb().query<BusinessTargetPackRow>(
        READ_BUSINESS_TARGET_PACK_QUERY,
        [input.businessId],
      );
    } catch {
      return null;
    }
    if (!row) return null;

    return {
      targetCpa: toNumberOrNull(row.target_cpa),
      targetRoas: toNumberOrNull(row.target_roas),
      breakEvenCpa: toNumberOrNull(row.break_even_cpa),
      breakEvenRoas: toNumberOrNull(row.break_even_roas),
      operatorAovAssumption: toNumberOrNull(row.aov_assumption),
      defaultRiskPosture: toEngineRiskPreset(row.default_risk_posture),
    };
  }

  async getDecisionCalibrationProfile(input: {
    businessId: string;
    channel: "meta";
    objectiveFamily: "sales";
  }): Promise<DecisionCalibrationProfileConfig | null> {
    let row: DecisionCalibrationProfileRow | undefined;
    try {
      [row] = await getDb().query<DecisionCalibrationProfileRow>(
        READ_DECISION_CALIBRATION_PROFILE_QUERY,
        [input.businessId, input.channel, input.objectiveFamily],
      );
    } catch {
      return null;
    }
    if (!row) return null;

    return {
      enginePresetLabel: toEngineRiskPreset(row.engine_preset_label),
      zeroConvBurnerMultiplier: toNumberOrNull(
        row.zero_conv_burner_multiplier,
      ),
      cutCandidateMultiplier: toNumberOrNull(row.cut_candidate_multiplier),
      sustainedLoserMultiplier: toNumberOrNull(
        row.sustained_loser_multiplier,
      ),
      hardCutMultiplier: toNumberOrNull(row.hard_cut_multiplier),
      scaleEvidenceMultiplier: toNumberOrNull(row.scale_evidence_multiplier),
      scalePurchaseMultiplier: toNumberOrNull(row.scale_purchase_multiplier),
      winnerMemoryMultiplier: toNumberOrNull(row.winner_memory_multiplier),
      recentSampleMultiplier: toNumberOrNull(row.recent_sample_multiplier),
      weakFunnelRateMultiplier: toNumberOrNull(
        row.weak_funnel_rate_multiplier,
      ),
      attributionAovAdjustmentMultiplier: toNumberOrNull(
        row.attribution_aov_adjustment_multiplier,
      ),
    };
  }

  async getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
  }): Promise<MetaAttributedAovResult> {
    return computeMetaAttributedAov({
      businessId: input.businessId,
      asOf: input.asOf,
      windowDays: input.windowDays,
      db: getDb(),
    });
  }
}
