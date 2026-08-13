import { createHash } from "node:crypto";
import { getDb } from "@/lib/db";
import { resolveBusinessTargetPackFreshness } from "@/lib/business-commercial";
import {
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import {
  buildDataLayerHealth,
  composeDataHealth,
  freshDataLayerHealth,
  STALE_TIER_WARNING_MAX_HOURS,
} from "./data-health";
import {
  FATIGUE_FREQUENCY_PRESSURE_QUANTILE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
} from "./config-values";
import { chunkDecisionRows } from "./batching";
import { computeFatigue, type HistoricalWindow } from "./fatigue";
import {
  computeMetaAttributedAov,
  type MetaAttributedAovResult,
} from "./meta-aov-calculator";
import { classifyMetaAovQuality } from "./spend-unit-resolver";
import {
  ENGINE_VERSION,
  type AccountCalibration,
  type AccountFunnelCalibration,
  type AdDecisionInput,
  type CalibrationCampaignKind,
  type CampaignObjective,
  type CommercialTargetFreshness,
  type CreativeFormat,
  type CreativeInput,
  type DataHealth,
  type DataLayerHealth,
  type EngineRiskPreset,
  type FallbackMode,
  type FormatFunnelBaseline,
  type FunnelDiagnosis,
  type FunnelStage,
  type LifecyclePosition,
  type MetaRanking,
  type MetaAovQuality,
  type SpendTrajectory,
  type StaleTier,
} from "./types";
import type {
  OperatorResponseResult,
  OperatorResponseType,
} from "./operator-response-detection";

const CALIBRATION_CAMPAIGN_KINDS: readonly CalibrationCampaignKind[] = [
  "all",
  "main",
  "test",
  "mixed",
];

function emptyCalibrationByKind<T>(): Record<
  CalibrationCampaignKind,
  T | null
> {
  return {
    all: null,
    main: null,
    test: null,
    mixed: null,
  };
}

export interface BusinessTargetPack {
  targetCpa: number | null;
  targetRoas: number | null;
  breakEvenCpa: number | null;
  breakEvenRoas: number | null;
  operatorAovAssumption: number | null;
  defaultRiskPosture: EngineRiskPreset | null;
  updatedAt?: string | null;
  freshness?: CommercialTargetFreshness;
}

export interface DecisionCalibrationProfileConfig {
  enginePresetLabel: EngineRiskPreset | null;
  zeroConvBurnerMultiplier: number | null;
  cutCandidateMultiplier: number | null;
  sustainedLoserMultiplier: number | null;
  hardCutMultiplier: number | null;
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

  /** Return one kind-segmented account calibration row. P1b data-only. */
  getAccountCalibrationByKind?(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountCalibration | null>;

  /** Return all available kind-segmented account calibration rows. P1b data-only. */
  getAccountCalibrationAllKinds?(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>>;

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

  /** Return one kind-segmented funnel calibration pack. P1b data-only. */
  getAccountFunnelCalibrationByKind?(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountFunnelCalibration | null>;

  /** Return all available kind-segmented funnel calibration packs. P1b data-only. */
  getAccountFunnelCalibrationAllKinds?(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountFunnelCalibration | null>>;

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
    asOf?: string;
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

export interface AdDecisionInputQuery {
  businessId: string;
  asOf: string;
  /** Exact producer/evaluation cutoff; required for point-in-time status truth. */
  decisionCutoff: string;
  providerAccountIds?: string[];
  adIds?: string[];
}

export const AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION =
  "native-ad-hydration-receipt.v1" as const;

export interface AdDecisionHydrationReceipt {
  contractVersion: typeof AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  scopeType: "account";
  scopeId: string;
  asOfDate: string;
  decisionCutoff: string;
  sourceRunId: string | null;
  sourceObservedAt: string | null;
  sourceCapturedAt: string | null;
  sourceRunHash: string | null;
  sourcePayloadHash: string | null;
  sourceExpectedRowCount: number | null;
  sourcePersistedRowCount: number | null;
  expectedAdCount: number;
  expectedAdIds: string[];
  expectedManifestHash: string;
  hydratedAdCount: number;
  hydratedManifestHash: string;
  sourceComplete: boolean;
  hydrationComplete: boolean;
  authoritativeForPrune: boolean;
  reason: string | null;
}

export interface AdDecisionHydrationResult {
  inputs: AdDecisionInput[];
  receipts: AdDecisionHydrationReceipt[];
  accountCoverageComplete: boolean;
}

export interface AdDecisionDataSource {
  hydrateAdDecisionInputs(
    input: AdDecisionInputQuery,
  ): Promise<AdDecisionHydrationResult>;
  listAdDecisionInputs(input: AdDecisionInputQuery): Promise<AdDecisionInput[]>;
  getAdDecisionInput(input: {
    businessId: string;
    providerAccountId: string;
    adId: string;
    asOf: string;
    decisionCutoff: string;
  }): Promise<AdDecisionInput | null>;
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
      effectiveCohort: "purchase",
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
      commercialTargetFreshness: "fresh",
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
      campaignKind: "all",
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

  async getAccountCalibrationByKind(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountCalibration | null> {
    return {
      ...(await this.getAccountCalibration(input)),
      campaignKind: input.campaignKind,
    };
  }

  async getAccountCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>> {
    const byKind = emptyCalibrationByKind<AccountCalibration>();
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      byKind[campaignKind] = await this.getAccountCalibrationByKind({
        ...input,
        campaignKind,
      });
    }
    return byKind;
  }

  async getCampaignCalibration(input: {
    businessId: string;
  }): Promise<CampaignCalibrationLookup> {
    return {
      calibration: {
        businessId: input.businessId,
        computedAt: new Date().toISOString(),
        campaignKind: "all",
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
      campaignKind: "all",
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

  async getAccountFunnelCalibrationByKind(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountFunnelCalibration | null> {
    return {
      ...(await this.getAccountFunnelCalibration()),
      campaignKind: input.campaignKind,
    };
  }

  async getAccountFunnelCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<
    Record<CalibrationCampaignKind, AccountFunnelCalibration | null>
  > {
    const byKind = emptyCalibrationByKind<AccountFunnelCalibration>();
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      byKind[campaignKind] = await this.getAccountFunnelCalibrationByKind({
        ...input,
        campaignKind,
      });
    }
    return byKind;
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

  async getBusinessTargetPack(input?: {
    businessId: string;
    asOf?: string;
  }): Promise<BusinessTargetPack | null> {
    const referenceTime = resolveTargetReferenceTime(input?.asOf);
    if (referenceTime === null) return null;
    return {
      targetCpa: null,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.71,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced",
      updatedAt: referenceTime.toISOString(),
      freshness: "fresh",
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
      : new Date(end.getTime() - (windowDays - 1) * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
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

const META_FUNNEL_COHORTS = new Set<MetaFunnelCohort>([
  "purchase",
  "mid_funnel",
  "lead",
  "traffic",
  "upper_funnel",
  "engagement",
  "unknown",
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
  effective_cohort_inputs: unknown;
  provider_account_count: unknown;
  campaign_count: unknown;
  adset_count: unknown;
  optimization_context_count: unknown;
  objective_count: unknown;
  context_identity_unknown: unknown;
  spend: unknown;
  purchases: unknown;
  purchase_value: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  frequency_pressure_threshold: unknown;
  recent_spend: unknown;
  recent_purchases: unknown;
  recent_impressions: unknown;
  recent_roas: unknown;
  effective_status: unknown;
  objective: unknown;
  campaign_id: unknown;
  first_seen_at: unknown;
  first_spend_at: unknown;
  last_spend_date: unknown;
  spend_24h: unknown;
  impressions_24h: unknown;
  review_status: unknown;
  policy_reason: unknown;
  disapproval_reason: unknown;
  limited_reason: unknown;
  age_days: unknown;
  data_freshness_hours: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  target_pack_updated_at: unknown;
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

type AdDecisionHydrationRow = Record<string, unknown> & {
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  account_timezone: unknown;
  account_currency: unknown;
  ad_id: unknown;
  ad_name: unknown;
  creative_id: unknown;
  creative_name: unknown;
  campaign_id: unknown;
  adset_id: unknown;
  objective: unknown;
  optimization_goal: unknown;
  custom_event_type: unknown;
  campaign_count: unknown;
  adset_count: unknown;
  optimization_context_count: unknown;
  objective_count: unknown;
  context_identity_unknown: unknown;
  metric_row_count: unknown;
  event_metrics_observed: unknown;
  spend: unknown;
  conversions: unknown;
  revenue: unknown;
  impressions: unknown;
  link_clicks: unknown;
  roas: unknown;
  cpa: unknown;
  ctr: unknown;
  frequency: unknown;
  recent_spend: unknown;
  recent_conversions: unknown;
  recent_revenue: unknown;
  recent_impressions: unknown;
  recent_roas: unknown;
  spend_24h: unknown;
  impressions_24h: unknown;
  first_seen_at: unknown;
  first_spend_at: unknown;
  last_spend_date: unknown;
  data_freshness_hours: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  target_pack_updated_at: unknown;
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
  current_dimension_id: unknown;
  current_ad_status: unknown;
  lifecycle_row_id: unknown;
  lifecycle_as_of_date: unknown;
  lifecycle_computed_at: unknown;
  lifecycle_source_max_updated_at: unknown;
  lifecycle_position: unknown;
  days_since_peak: unknown;
  peak_roas_30d: unknown;
  peak_confidence: unknown;
  spend_trajectory_30d: unknown;
  spend_slope_7d: unknown;
  spend_slope_30d: unknown;
  roas_slope_7d: unknown;
  roas_slope_30d: unknown;
  fatigue_status: unknown;
  quality_ranking: unknown;
  engagement_rate_ranking: unknown;
  conversion_rate_ranking: unknown;
  creative_format: unknown;
};

type AdEntityStateRow = Record<string, unknown> & {
  event_kind: unknown;
  id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  entity_id: unknown;
  entity_name: unknown;
  campaign_id: unknown;
  adset_id: unknown;
  creative_id: unknown;
  configured_status: unknown;
  effective_status: unknown;
  review_status: unknown;
  policy_status: unknown;
  policy_reasons_json: unknown;
  observed_at: unknown;
  captured_at: unknown;
  tombstone_reason: unknown;
};

type PresentAdStateSeedRow = Record<string, unknown> & {
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  ad_id: unknown;
  campaign_id: unknown;
  adset_id: unknown;
  creative_id: unknown;
  captured_at: unknown;
};

type AdHydrationReceiptRow = Record<string, unknown> & {
  business_ref_id: unknown;
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  source_run_id: unknown;
  source_observed_at: unknown;
  source_captured_at: unknown;
  source_run_hash: unknown;
  source_payload_hash: unknown;
  source_expected_row_count: unknown;
  source_persisted_row_count: unknown;
  expected_ad_ids: unknown;
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
  campaign_kind: unknown;
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
  campaign_kind: unknown;
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
  updated_at: unknown;
};

type DecisionCalibrationProfileRow = Record<string, unknown> & {
  engine_preset_label: unknown;
  zero_conv_burner_multiplier: unknown;
  cut_candidate_multiplier: unknown;
  sustained_loser_multiplier: unknown;
  hard_cut_multiplier: unknown;
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
  effective_cohort_inputs: unknown;
  provider_account_count: unknown;
  campaign_count: unknown;
  adset_count: unknown;
  optimization_context_count: unknown;
  objective_count: unknown;
  context_identity_unknown: unknown;
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
  first_seen_at: unknown;
  first_spend_at: unknown;
  last_active_date: unknown;
  spend_24h: unknown;
  impressions_24h: unknown;
  review_status: unknown;
  policy_reason: unknown;
  disapproval_reason: unknown;
  limited_reason: unknown;
  source_max_updated_at: unknown;
  data_freshness_hours: unknown;
  fatigue_status: unknown;
  target_roas: unknown;
  break_even_roas: unknown;
  target_pack_updated_at: unknown;
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

export const HYDRATE_AD_DECISION_INPUTS_QUERY = `
/* ad-decision-hydration: native business/account/ad grain */
WITH assigned_accounts AS (
  SELECT
    binding.business_id,
    binding.provider_account_ref_id,
    binding.provider_account_id
  FROM business_provider_accounts binding
  WHERE binding.business_id = $1::text
    AND binding.provider = 'meta'
    -- Current execution, not historical attribution. This CTE decides which
    -- accounts the engine hydrates and decides FOR right now, so a deselected
    -- account must not receive decisions. Already-written snapshots, outcomes
    -- and backtests join on provider_account_ref_id and are untouched, so past
    -- attribution still resolves through a deselected binding.
    AND binding.is_selected
    AND (NOT $4::boolean OR binding.provider_account_id = ANY($3::text[]))
),
selected_ad_days AS (
  SELECT d.*
  FROM meta_ad_daily d
  INNER JOIN assigned_accounts assignment
    ON assignment.business_id = d.business_id
   AND assignment.provider_account_id = d.provider_account_id
  WHERE d.business_id = $1::text
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
    AND (NOT $4::boolean OR d.provider_account_id = ANY($3::text[]))
    AND (NOT $6::boolean OR d.ad_id = ANY($5::text[]))
    AND d.truth_state = 'finalized'
    AND d.validation_status = 'passed'
    AND d.created_at <= $11::timestamptz
    AND d.updated_at <= $11::timestamptz
),
metric_ads AS (
  SELECT DISTINCT business_id, provider_account_id, ad_id
  FROM selected_ad_days
),
present_dimension_ads AS (
  SELECT d.business_id, d.provider_account_id, d.ad_id
  FROM meta_ad_dimensions d
  INNER JOIN assigned_accounts assignment
    ON assignment.business_id = d.business_id
   AND assignment.provider_account_id = d.provider_account_id
  WHERE $12::boolean
    AND d.business_id = $1::text
    AND (NOT $4::boolean OR d.provider_account_id = ANY($3::text[]))
    AND (NOT $6::boolean OR d.ad_id = ANY($5::text[]))
    AND (
      UPPER(COALESCE(NULLIF(BTRIM(d.ad_status), ''), '')) = 'ACTIVE'
      OR (
        NULLIF(BTRIM(d.ad_status), '') IS NULL
        AND d.last_seen_at::date = $2::date
      )
    )
    AND d.created_at <= $11::timestamptz
    AND d.updated_at <= $11::timestamptz
),
present_state_ads AS (
  SELECT *
  FROM jsonb_to_recordset($13::jsonb) AS row(
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    ad_id text,
    campaign_id text,
    adset_id text,
    creative_id text,
    captured_at timestamptz
  )
),
selected_ads AS (
  SELECT business_id, provider_account_id, ad_id FROM metric_ads
  UNION
  SELECT business_id, provider_account_id, ad_id FROM present_dimension_ads
  UNION
  SELECT business_id, provider_account_id, ad_id FROM present_state_ads
),
selected_accounts AS (
  SELECT DISTINCT business_id, provider_account_id
  FROM selected_ads
),
account_identity AS (
  SELECT DISTINCT ON (d.provider_account_id)
    d.provider_account_id,
    NULLIF(BTRIM(d.account_timezone), '') AS account_timezone,
    NULLIF(BTRIM(d.account_currency), '') AS account_currency
  FROM meta_ad_daily d
  INNER JOIN selected_accounts selected
    ON selected.business_id = d.business_id
   AND selected.provider_account_id = d.provider_account_id
  WHERE d.business_id = $1::text
    AND d.date <= $2::date
    AND d.truth_state = 'finalized'
    AND d.validation_status = 'passed'
    AND d.created_at <= $11::timestamptz
    AND d.updated_at <= $11::timestamptz
    AND NULLIF(BTRIM(d.account_timezone), '') IS NOT NULL
    AND NULLIF(BTRIM(d.account_currency), '') IS NOT NULL
  ORDER BY d.provider_account_id, d.date DESC, d.updated_at DESC, d.id DESC
),
metric_context_days AS (
  SELECT
    d.provider_account_id,
    d.ad_id,
    d.date,
    d.updated_at AS source_updated_at,
    NULLIF(BTRIM(d.campaign_id), '') AS campaign_id,
    NULLIF(BTRIM(d.adset_id), '') AS adset_id,
    COALESCE(
      NULLIF(BTRIM(c.objective), ''),
      NULLIF(BTRIM(current_campaign_config.objective), '')
    ) AS objective,
    COALESCE(
      NULLIF(BTRIM(a.optimization_goal), ''),
      NULLIF(BTRIM(c.optimization_goal), ''),
      NULLIF(BTRIM(current_adset_config.optimization_goal), ''),
      NULLIF(BTRIM(current_campaign_config.optimization_goal), '')
    ) AS optimization_goal,
    COALESCE(
      NULLIF(BTRIM(a.custom_event_type), ''),
      NULLIF(BTRIM(c.custom_event_type), ''),
      NULLIF(BTRIM(current_adset_config.custom_event_type), ''),
      NULLIF(BTRIM(current_campaign_config.custom_event_type), '')
    ) AS custom_event_type
  FROM selected_ad_days d
  LEFT JOIN meta_adset_daily a
    ON a.business_id = d.business_id
   AND a.provider_account_id = d.provider_account_id
   AND a.date = d.date
   AND a.adset_id = d.adset_id
   AND a.truth_state = 'finalized'
   AND a.validation_status = 'passed'
   AND a.created_at <= $11::timestamptz
   AND a.updated_at <= $11::timestamptz
  LEFT JOIN meta_campaign_daily c
    ON c.business_id = d.business_id
   AND c.provider_account_id = d.provider_account_id
   AND c.date = d.date
   AND c.campaign_id = d.campaign_id
   AND c.truth_state = 'finalized'
   AND c.validation_status = 'passed'
   AND c.created_at <= $11::timestamptz
   AND c.updated_at <= $11::timestamptz
  LEFT JOIN LATERAL (
    SELECT config.optimization_goal, config.custom_event_type
    FROM meta_adset_config_history config
    WHERE config.business_id = d.business_id
      AND config.provider_account_id = d.provider_account_id
      AND config.adset_id = d.adset_id
      AND config.captured_at <= $11::timestamptz
      AND config.created_at <= $11::timestamptz
    ORDER BY config.captured_at DESC, config.created_at DESC, config.id DESC
    LIMIT 1
  ) current_adset_config ON $12::boolean
  LEFT JOIN LATERAL (
    SELECT config.objective, config.optimization_goal, config.custom_event_type
    FROM meta_campaign_config_history config
    WHERE config.business_id = d.business_id
      AND config.provider_account_id = d.provider_account_id
      AND config.campaign_id = d.campaign_id
      AND config.captured_at <= $11::timestamptz
      AND config.created_at <= $11::timestamptz
    ORDER BY config.captured_at DESC, config.created_at DESC, config.id DESC
    LIMIT 1
  ) current_campaign_config ON $12::boolean
),
dimension_only_context AS (
  SELECT
    selected.provider_account_id,
    selected.ad_id,
    $2::date AS date,
    COALESCE(dimensions.updated_at, state.captured_at) AS source_updated_at,
    COALESCE(
      NULLIF(BTRIM(state.campaign_id), ''),
      NULLIF(BTRIM(dimensions.campaign_id), '')
    ) AS campaign_id,
    COALESCE(
      NULLIF(BTRIM(state.adset_id), ''),
      NULLIF(BTRIM(dimensions.adset_id), '')
    ) AS adset_id,
    NULLIF(BTRIM(campaign_config.objective), '') AS objective,
    COALESCE(
      NULLIF(BTRIM(adset_config.optimization_goal), ''),
      NULLIF(BTRIM(campaign_config.optimization_goal), '')
    ) AS optimization_goal,
    COALESCE(
      NULLIF(BTRIM(adset_config.custom_event_type), ''),
      NULLIF(BTRIM(campaign_config.custom_event_type), '')
    ) AS custom_event_type
  FROM selected_ads selected
  LEFT JOIN meta_ad_dimensions dimensions
    ON dimensions.business_id = selected.business_id
   AND dimensions.provider_account_id = selected.provider_account_id
   AND dimensions.ad_id = selected.ad_id
   AND dimensions.created_at <= $11::timestamptz
   AND dimensions.updated_at <= $11::timestamptz
  LEFT JOIN present_state_ads state
    ON state.provider_account_id = selected.provider_account_id
   AND state.ad_id = selected.ad_id
  LEFT JOIN LATERAL (
    SELECT config.optimization_goal, config.custom_event_type
    FROM meta_adset_config_history config
    WHERE config.business_id = selected.business_id
      AND config.provider_account_id = selected.provider_account_id
      AND config.adset_id = COALESCE(
        NULLIF(BTRIM(state.adset_id), ''),
        NULLIF(BTRIM(dimensions.adset_id), '')
      )
      AND config.captured_at <= $11::timestamptz
      AND config.created_at <= $11::timestamptz
    ORDER BY config.captured_at DESC, config.created_at DESC, config.id DESC
    LIMIT 1
  ) adset_config ON true
  LEFT JOIN LATERAL (
    SELECT config.objective, config.optimization_goal, config.custom_event_type
    FROM meta_campaign_config_history config
    WHERE config.business_id = selected.business_id
      AND config.provider_account_id = selected.provider_account_id
      AND config.campaign_id = COALESCE(
        NULLIF(BTRIM(state.campaign_id), ''),
        NULLIF(BTRIM(dimensions.campaign_id), '')
      )
      AND config.captured_at <= $11::timestamptz
      AND config.created_at <= $11::timestamptz
    ORDER BY config.captured_at DESC, config.created_at DESC, config.id DESC
    LIMIT 1
  ) campaign_config ON true
  WHERE $12::boolean
    AND NOT EXISTS (
      SELECT 1
      FROM selected_ad_days day
      WHERE day.provider_account_id = selected.provider_account_id
        AND day.ad_id = selected.ad_id
    )
),
context_days AS (
  SELECT * FROM metric_context_days
  UNION ALL
  SELECT * FROM dimension_only_context
),
context_cardinality AS (
  SELECT
    provider_account_id,
    ad_id,
    COUNT(DISTINCT campaign_id) AS campaign_count,
    COUNT(DISTINCT adset_id) AS adset_count,
    COUNT(DISTINCT (optimization_goal, custom_event_type)) FILTER (
      WHERE optimization_goal IS NOT NULL OR custom_event_type IS NOT NULL
    ) AS optimization_context_count,
    COUNT(DISTINCT objective) AS objective_count,
    BOOL_OR(
      campaign_id IS NULL
      OR adset_id IS NULL
      OR objective IS NULL
      OR (optimization_goal IS NULL AND custom_event_type IS NULL)
    ) AS has_unknown_context
  FROM context_days
  GROUP BY provider_account_id, ad_id
),
latest_context AS (
  SELECT DISTINCT ON (provider_account_id, ad_id)
    provider_account_id,
    ad_id,
    campaign_id,
    adset_id,
    objective,
    optimization_goal,
    custom_event_type
  FROM context_days
  ORDER BY provider_account_id, ad_id, date DESC, source_updated_at DESC
),
metric_cumulative AS (
  SELECT
    provider_account_id,
    ad_id,
    COUNT(*)::integer AS metric_row_count,
    BOOL_OR(
      payload_json ? 'outbound_clicks'
      OR payload_json ? 'landing_page_views'
      OR payload_json ? 'add_to_cart'
      OR payload_json ? 'initiate_checkout'
      OR payload_json ? 'thumbstop'
      OR payload_json ? 'video25'
      OR payload_json ? 'video50'
      OR payload_json ? 'video75'
      OR payload_json ? 'video100'
    ) AS event_metrics_observed,
    MAX(ad_name_current) FILTER (WHERE ad_name_current IS NOT NULL) AS ad_name,
    SUM(spend) AS spend,
    SUM(conversions) AS conversions,
    SUM(revenue) AS revenue,
    SUM(impressions) AS impressions,
    SUM(link_clicks) AS link_clicks,
    CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) END AS roas,
    CASE WHEN SUM(conversions) > 0 THEN SUM(spend) / SUM(conversions) END AS cpa,
    CASE
      WHEN SUM(impressions) > 0
      THEN SUM(clicks)::numeric / NULLIF(SUM(impressions), 0) * 100
    END AS ctr,
    CASE
      WHEN SUM(reach) > 0
      THEN SUM(impressions)::numeric / NULLIF(SUM(reach), 0)
    END AS frequency,
    CASE
      WHEN SUM(impressions) > 0
      THEN SUM(spend) / NULLIF(SUM(impressions), 0) * 1000
    END AS cpm,
    SUM((NULLIF(payload_json->>'outbound_clicks', ''))::numeric)
      FILTER (WHERE payload_json ? 'outbound_clicks') AS outbound_clicks,
    SUM((NULLIF(payload_json->>'landing_page_views', ''))::numeric)
      FILTER (WHERE payload_json ? 'landing_page_views') AS landing_page_views,
    SUM((NULLIF(payload_json->>'add_to_cart', ''))::numeric)
      FILTER (WHERE payload_json ? 'add_to_cart') AS add_to_cart,
    SUM((NULLIF(payload_json->>'initiate_checkout', ''))::numeric)
      FILTER (WHERE payload_json ? 'initiate_checkout') AS initiate_checkout,
    CASE WHEN SUM(impressions) FILTER (WHERE payload_json ? 'thumbstop') > 0 THEN
      SUM((NULLIF(payload_json->>'thumbstop', ''))::numeric * impressions)
        FILTER (WHERE payload_json ? 'thumbstop')
        / NULLIF(SUM(impressions) FILTER (WHERE payload_json ? 'thumbstop'), 0)
    END AS thumbstop,
    CASE WHEN SUM(impressions) FILTER (WHERE payload_json ? 'video25') > 0 THEN
      SUM((NULLIF(payload_json->>'video25', ''))::numeric * impressions)
        FILTER (WHERE payload_json ? 'video25')
        / NULLIF(SUM(impressions) FILTER (WHERE payload_json ? 'video25'), 0)
    END AS video25_rate,
    CASE WHEN SUM(impressions) FILTER (WHERE payload_json ? 'video50') > 0 THEN
      SUM((NULLIF(payload_json->>'video50', ''))::numeric * impressions)
        FILTER (WHERE payload_json ? 'video50')
        / NULLIF(SUM(impressions) FILTER (WHERE payload_json ? 'video50'), 0)
    END AS video50_rate,
    CASE WHEN SUM(impressions) FILTER (WHERE payload_json ? 'video75') > 0 THEN
      SUM((NULLIF(payload_json->>'video75', ''))::numeric * impressions)
        FILTER (WHERE payload_json ? 'video75')
        / NULLIF(SUM(impressions) FILTER (WHERE payload_json ? 'video75'), 0)
    END AS video75_rate,
    CASE WHEN SUM(impressions) FILTER (WHERE payload_json ? 'video100') > 0 THEN
      SUM((NULLIF(payload_json->>'video100', ''))::numeric * impressions)
        FILTER (WHERE payload_json ? 'video100')
        / NULLIF(SUM(impressions) FILTER (WHERE payload_json ? 'video100'), 0)
    END AS video100_rate,
    MAX(updated_at) AS source_max_updated_at
  FROM selected_ad_days
  GROUP BY provider_account_id, ad_id
),
cumulative AS (
  SELECT
    selected.provider_account_id,
    selected.ad_id,
    metrics.metric_row_count,
    COALESCE(metrics.event_metrics_observed, FALSE) AS event_metrics_observed,
    metrics.ad_name,
    metrics.spend,
    metrics.conversions,
    metrics.revenue,
    metrics.impressions,
    metrics.link_clicks,
    metrics.roas,
    metrics.cpa,
    metrics.ctr,
    metrics.frequency,
    metrics.cpm,
    metrics.outbound_clicks,
    metrics.landing_page_views,
    metrics.add_to_cart,
    metrics.initiate_checkout,
    metrics.thumbstop,
    metrics.video25_rate,
    metrics.video50_rate,
    metrics.video75_rate,
    metrics.video100_rate,
    metrics.source_max_updated_at
  FROM selected_ads selected
  LEFT JOIN metric_cumulative metrics
    ON metrics.provider_account_id = selected.provider_account_id
   AND metrics.ad_id = selected.ad_id
),
recent AS (
  SELECT
    provider_account_id,
    ad_id,
    SUM(spend) AS spend,
    SUM(conversions) AS conversions,
    SUM(revenue) AS revenue,
    SUM(impressions) AS impressions,
    CASE WHEN SUM(spend) > 0 THEN SUM(revenue) / SUM(spend) END AS roas
  FROM selected_ad_days
  WHERE date BETWEEN ($2::date - INTERVAL '6 days') AND $2::date
  GROUP BY provider_account_id, ad_id
),
recent_24h AS (
  SELECT
    provider_account_id,
    ad_id,
    SUM(spend) AS spend,
    SUM(impressions) AS impressions
  FROM selected_ad_days
  WHERE date = $2::date
  GROUP BY provider_account_id, ad_id
),
activity_bounds AS (
  SELECT
    d.provider_account_id,
    d.ad_id,
    MIN(d.date) FILTER (WHERE d.spend > 0) AS first_spend_at,
    MAX(d.date) FILTER (WHERE d.spend > 0) AS last_spend_date
  FROM meta_ad_daily d
  INNER JOIN selected_ads selected
    ON selected.business_id = d.business_id
   AND selected.provider_account_id = d.provider_account_id
   AND selected.ad_id = d.ad_id
  WHERE d.business_id = $1::text
    AND d.date <= $2::date
    AND d.truth_state = 'finalized'
    AND d.validation_status = 'passed'
    AND d.created_at <= $11::timestamptz
    AND d.updated_at <= $11::timestamptz
  GROUP BY d.provider_account_id, d.ad_id
)
SELECT
  assignment.provider_account_ref_id,
  cumulative.provider_account_id,
  COALESCE(
    account_identity.account_timezone,
    CASE WHEN $12::boolean THEN NULLIF(BTRIM(provider_account.timezone), '') END
  ) AS account_timezone,
  COALESCE(
    account_identity.account_currency,
    CASE WHEN $12::boolean THEN NULLIF(BTRIM(provider_account.currency), '') END
  ) AS account_currency,
  cumulative.ad_id,
  COALESCE(cumulative.ad_name, dimensions.ad_name_current) AS ad_name,
  COALESCE(dimensions.creative_id, state_dimension.creative_id) AS creative_id,
  creative_dimensions.creative_name,
  CASE WHEN cardinality.campaign_count = 1 THEN latest.campaign_id END AS campaign_id,
  CASE WHEN cardinality.adset_count = 1 THEN latest.adset_id END AS adset_id,
  CASE WHEN cardinality.objective_count = 1 THEN latest.objective END AS objective,
  CASE WHEN cardinality.optimization_context_count = 1 THEN latest.optimization_goal END AS optimization_goal,
  CASE WHEN cardinality.optimization_context_count = 1 THEN latest.custom_event_type END AS custom_event_type,
  COALESCE(cardinality.campaign_count, 0) AS campaign_count,
  COALESCE(cardinality.adset_count, 0) AS adset_count,
  COALESCE(cardinality.optimization_context_count, 0) AS optimization_context_count,
  COALESCE(cardinality.objective_count, 0) AS objective_count,
  (
    COALESCE(cardinality.has_unknown_context, TRUE)
    OR cardinality.campaign_count <> 1
    OR cardinality.adset_count <> 1
    OR cardinality.optimization_context_count <> 1
    OR cardinality.objective_count <> 1
  ) AS context_identity_unknown,
  COALESCE(cumulative.metric_row_count, 0) AS metric_row_count,
  cumulative.event_metrics_observed,
  cumulative.spend,
  cumulative.conversions,
  cumulative.revenue,
  cumulative.impressions,
  cumulative.link_clicks,
  cumulative.roas,
  cumulative.cpa,
  cumulative.ctr,
  cumulative.frequency,
  recent.spend AS recent_spend,
  recent.conversions AS recent_conversions,
  recent.revenue AS recent_revenue,
  recent.impressions AS recent_impressions,
  recent.roas AS recent_roas,
  recent_24h.spend AS spend_24h,
  recent_24h.impressions AS impressions_24h,
  dimensions.first_seen_at,
  bounds.first_spend_at,
  bounds.last_spend_date,
  CASE WHEN cumulative.source_max_updated_at IS NOT NULL THEN GREATEST(
    0,
    FLOOR(EXTRACT(EPOCH FROM ($11::timestamptz - cumulative.source_max_updated_at)) / 3600)
  ) END AS data_freshness_hours,
  $7::double precision AS target_roas,
  $8::double precision AS break_even_roas,
  $9::timestamptz AS target_pack_updated_at,
  cumulative.cpm,
  cumulative.outbound_clicks,
  cumulative.landing_page_views,
  cumulative.add_to_cart,
  cumulative.initiate_checkout,
  cumulative.thumbstop,
  cumulative.video25_rate,
  cumulative.video50_rate,
  cumulative.video75_rate,
  cumulative.video100_rate,
  dimensions.id AS current_dimension_id,
  dimensions.ad_status AS current_ad_status,
  lifecycle.id AS lifecycle_row_id,
  lifecycle.as_of_date::text AS lifecycle_as_of_date,
  lifecycle.computed_at AS lifecycle_computed_at,
  lifecycle.source_max_updated_at AS lifecycle_source_max_updated_at,
  lifecycle.lifecycle_position,
  lifecycle.days_since_peak,
  lifecycle.peak_roas_30d,
  lifecycle.peak_confidence,
  lifecycle.spend_trajectory_30d,
  lifecycle.spend_slope_7d,
  lifecycle.spend_slope_30d,
  lifecycle.roas_slope_7d,
  lifecycle.roas_slope_30d,
  lifecycle.fatigue_status,
  lifecycle.quality_ranking,
  lifecycle.engagement_rate_ranking,
  lifecycle.conversion_rate_ranking,
  COALESCE(lifecycle.creative_format, creative_dimensions.asset_type) AS creative_format
FROM cumulative
INNER JOIN assigned_accounts assignment
  ON assignment.business_id = $1::text
 AND assignment.provider_account_id = cumulative.provider_account_id
INNER JOIN provider_accounts provider_account
  ON provider_account.id = assignment.provider_account_ref_id
 AND provider_account.external_account_id = assignment.provider_account_id
LEFT JOIN account_identity
  ON account_identity.provider_account_id = cumulative.provider_account_id
LEFT JOIN context_cardinality cardinality
  ON cardinality.provider_account_id = cumulative.provider_account_id
 AND cardinality.ad_id = cumulative.ad_id
LEFT JOIN latest_context latest
  ON latest.provider_account_id = cumulative.provider_account_id
 AND latest.ad_id = cumulative.ad_id
LEFT JOIN recent
  ON recent.provider_account_id = cumulative.provider_account_id
 AND recent.ad_id = cumulative.ad_id
LEFT JOIN recent_24h
  ON recent_24h.provider_account_id = cumulative.provider_account_id
 AND recent_24h.ad_id = cumulative.ad_id
LEFT JOIN activity_bounds bounds
  ON bounds.provider_account_id = cumulative.provider_account_id
 AND bounds.ad_id = cumulative.ad_id
LEFT JOIN meta_ad_dimensions dimensions
  ON $12::boolean
 AND dimensions.business_id = $1::text
 AND dimensions.provider_account_id = cumulative.provider_account_id
 AND dimensions.ad_id = cumulative.ad_id
 AND dimensions.created_at <= $11::timestamptz
 AND dimensions.updated_at <= $11::timestamptz
LEFT JOIN present_state_ads state_dimension
  ON state_dimension.business_id = $1::text
 AND state_dimension.provider_account_id = cumulative.provider_account_id
 AND state_dimension.ad_id = cumulative.ad_id
LEFT JOIN meta_creative_dimensions creative_dimensions
  ON $12::boolean
 AND creative_dimensions.business_id = $1::text
 AND creative_dimensions.provider_account_id = cumulative.provider_account_id
 AND creative_dimensions.creative_id = COALESCE(
   dimensions.creative_id,
   state_dimension.creative_id
 )
 AND creative_dimensions.created_at <= $11::timestamptz
 AND creative_dimensions.updated_at <= $11::timestamptz
LEFT JOIN LATERAL (
  SELECT
    row.id,
    row.as_of_date,
    row.computed_at,
    row.source_max_updated_at,
    row.lifecycle_position,
    row.days_since_peak,
    row.peak_roas_30d,
    row.peak_confidence,
    row.spend_trajectory_30d,
    row.spend_slope_7d,
    row.spend_slope_30d,
    row.roas_slope_7d,
    row.roas_slope_30d,
    row.fatigue_status,
    row.quality_ranking,
    row.engagement_rate_ranking,
    row.conversion_rate_ranking,
    row.creative_format
  FROM engine_v3_creative_lifecycle_daily row
  WHERE row.business_ref_id = $1::uuid
    AND row.creative_id = COALESCE(
      dimensions.creative_id,
      state_dimension.creative_id
    )
    AND row.as_of_date <= $2::date
    AND row.engine_version = $10
    AND row.computed_at <= $11::timestamptz
  ORDER BY row.as_of_date DESC, row.computed_at DESC, row.id DESC
  LIMIT 1
) lifecycle ON COALESCE(dimensions.creative_id, state_dimension.creative_id) IS NOT NULL
ORDER BY cumulative.provider_account_id, cumulative.ad_id
`;

export const READ_AD_ENTITY_STATE_AS_OF_QUERY = `
/* ad-decision-state-asof: generation-bound cutoff-strict state versus tombstone */
WITH truth_events AS (
  SELECT
    'state'::text AS event_kind,
    state.id,
    state.provider_account_ref_id,
    state.provider_account_id,
    state.entity_id,
    state.entity_name,
    state.campaign_id,
    state.adset_id,
    state.creative_id,
    state.configured_status,
    state.effective_status,
    state.review_status,
    state.policy_status,
    state.policy_reasons_json,
    state.observed_at,
    state.captured_at,
    state.created_at,
    NULL::text AS tombstone_reason
  FROM meta_entity_state_history state
  WHERE state.business_ref_id = $1::uuid
    AND state.business_id = $1::text
    AND state.provider_account_ref_id = $2::uuid
    AND state.provider_account_id = $3
    AND state.entity_type = 'ad'
    AND state.entity_id = ANY($4::text[])
    AND state.observed_at <= $5::timestamptz
    AND ($6::timestamptz IS NULL OR state.captured_at >= $6::timestamptz)
    AND state.captured_at <= $5::timestamptz
    AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
    AND state.presence = 'present'

  UNION ALL

  SELECT
    'tombstone'::text AS event_kind,
    tombstone.id,
    tombstone.provider_account_ref_id,
    tombstone.provider_account_id,
    tombstone.entity_id,
    NULL::text AS entity_name,
    NULL::text AS campaign_id,
    NULL::text AS adset_id,
    NULL::text AS creative_id,
    NULL::text AS configured_status,
    NULL::text AS effective_status,
    NULL::text AS review_status,
    NULL::text AS policy_status,
    NULL::jsonb AS policy_reasons_json,
    tombstone.observed_at,
    tombstone.captured_at,
    tombstone.created_at,
    tombstone.reason AS tombstone_reason
  FROM meta_entity_tombstones tombstone
  WHERE tombstone.business_ref_id = $1::uuid
    AND tombstone.business_id = $1::text
    AND tombstone.provider_account_ref_id = $2::uuid
    AND tombstone.provider_account_id = $3
    AND tombstone.entity_type = 'ad'
    AND tombstone.entity_id = ANY($4::text[])
    AND tombstone.observed_at <= $5::timestamptz
    AND ($6::timestamptz IS NULL OR tombstone.captured_at >= $6::timestamptz)
    AND tombstone.captured_at <= $5::timestamptz
    AND tombstone.reason IN ('explicit_deleted', 'explicit_not_found')
)
SELECT DISTINCT ON (entity_id)
  event_kind,
  id,
  provider_account_ref_id,
  provider_account_id,
  entity_id,
  entity_name,
  campaign_id,
  adset_id,
  creative_id,
  configured_status,
  effective_status,
  review_status,
  policy_status,
  policy_reasons_json,
  observed_at::text AS observed_at,
  captured_at::text AS captured_at,
  tombstone_reason
FROM truth_events
ORDER BY entity_id, observed_at DESC, captured_at DESC,
  (event_kind = 'tombstone') DESC, created_at DESC, id DESC
`;

export const READ_PRESENT_AD_STATE_SEEDS_QUERY = `
/* ad-decision-present-state-seeds: current truth, explicit tombstone wins ties */
WITH truth_events AS (
  SELECT
    'state'::text AS event_kind,
    state.id,
    state.business_id,
    state.provider_account_ref_id,
    state.provider_account_id,
    state.entity_id AS ad_id,
    state.campaign_id,
    state.adset_id,
    state.creative_id,
    state.observed_at,
    state.captured_at,
    state.created_at
  FROM meta_entity_state_history state
  WHERE state.business_ref_id = $1::uuid
    AND state.business_id = $1::text
    AND state.entity_type = 'ad'
    AND state.presence = 'present'
    AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
    AND state.observed_at <= $2::timestamptz
    AND state.captured_at <= $2::timestamptz
    AND (NOT $4::boolean OR state.provider_account_id = ANY($3::text[]))
    AND (NOT $6::boolean OR state.entity_id = ANY($5::text[]))

  UNION ALL

  SELECT
    'tombstone'::text AS event_kind,
    tombstone.id,
    tombstone.business_id,
    tombstone.provider_account_ref_id,
    tombstone.provider_account_id,
    tombstone.entity_id AS ad_id,
    NULL::text AS campaign_id,
    NULL::text AS adset_id,
    NULL::text AS creative_id,
    tombstone.observed_at,
    tombstone.captured_at,
    tombstone.created_at
  FROM meta_entity_tombstones tombstone
  WHERE tombstone.business_ref_id = $1::uuid
    AND tombstone.business_id = $1::text
    AND tombstone.entity_type = 'ad'
    AND tombstone.reason IN ('explicit_deleted', 'explicit_not_found')
    AND tombstone.observed_at <= $2::timestamptz
    AND tombstone.captured_at <= $2::timestamptz
    AND (NOT $4::boolean OR tombstone.provider_account_id = ANY($3::text[]))
    AND (NOT $6::boolean OR tombstone.entity_id = ANY($5::text[]))
), latest AS (
  SELECT DISTINCT ON (provider_account_id, ad_id) *
  FROM truth_events
  ORDER BY provider_account_id, ad_id, observed_at DESC, captured_at DESC,
    (event_kind = 'tombstone') DESC, created_at DESC, id DESC
)
SELECT business_id, provider_account_ref_id, provider_account_id, ad_id,
  campaign_id, adset_id, creative_id, captured_at
FROM latest
WHERE event_kind = 'state'
ORDER BY provider_account_id, ad_id
`;

/** Backward-compatible export name; the query now seeds every present ad. */
export const READ_PRESENT_ACTIVE_AD_STATE_SEEDS_QUERY =
  READ_PRESENT_AD_STATE_SEEDS_QUERY;

export const READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY = `
/* ad-decision-hydration-receipts: same-day complete account manifest proof */
WITH assigned_accounts AS (
  SELECT
    $1::uuid AS business_ref_id,
    binding.business_id,
    binding.provider_account_ref_id,
    binding.provider_account_id
  FROM business_provider_accounts binding
  WHERE binding.business_id = $1::text
    AND binding.provider = 'meta'
    -- Must match the hydration CTE above exactly. This proves the manifest is
    -- complete for the accounts being hydrated; a wider set here would report
    -- the run as incomplete for accounts that were deliberately excluded.
    AND binding.is_selected
    AND (NOT $5::boolean OR binding.provider_account_id = ANY($4::text[]))
), complete_runs AS (
  SELECT
    account.business_ref_id,
    account.business_id,
    account.provider_account_ref_id,
    account.provider_account_id,
    run.id AS source_run_id,
    run.observed_at AS source_observed_at,
    run.captured_at AS source_captured_at,
    run.run_hash AS source_run_hash,
    run.payload_hash AS source_payload_hash,
    run.row_count AS source_expected_row_count
  FROM assigned_accounts account
  LEFT JOIN LATERAL (
    SELECT run.*
    FROM meta_entity_observation_runs run
    WHERE run.business_ref_id = account.business_ref_id
      AND run.business_id = account.business_id
      AND run.provider_account_ref_id = account.provider_account_ref_id
      AND run.provider_account_id = account.provider_account_id
      AND run.entity_type = 'ad'
      AND run.completeness = 'complete'
      AND run.observed_at >= $2::date
      AND run.observed_at <= $3::timestamptz
      AND run.captured_at <= $3::timestamptz
      -- Compaction may retain a duplicate run receipt while removing its
      -- redundant state rows. Skip only fully removed positive-row runs;
      -- base_counts still exposes partially retained sets as a mismatch.
      AND (
        run.row_count = 0
        OR EXISTS (
          SELECT 1
          FROM meta_entity_state_history retained_state
          WHERE retained_state.run_id = run.id
            AND retained_state.business_ref_id = run.business_ref_id
            AND retained_state.business_id = run.business_id
            AND retained_state.provider_account_ref_id =
              run.provider_account_ref_id
            AND retained_state.provider_account_id = run.provider_account_id
            AND retained_state.entity_type = run.entity_type
        )
      )
    ORDER BY run.observed_at DESC, run.captured_at DESC, run.created_at DESC, run.id DESC
    LIMIT 1
  ) run ON true
), base_counts AS (
  SELECT
    run.source_run_id,
    COUNT(state.id)::integer AS source_persisted_row_count
  FROM complete_runs run
  LEFT JOIN meta_entity_state_history state
    ON state.run_id = run.source_run_id
   AND state.business_ref_id = run.business_ref_id
   AND state.business_id = run.business_id
   AND state.provider_account_ref_id = run.provider_account_ref_id
   AND state.provider_account_id = run.provider_account_id
   AND state.entity_type = 'ad'
   AND state.presence = 'present'
  GROUP BY run.source_run_id
), truth_events AS (
  SELECT
    run.provider_account_id,
    'state'::text AS event_kind,
    state.id,
    state.entity_id,
    state.observed_at,
    state.captured_at,
    state.created_at
  FROM complete_runs run
  INNER JOIN meta_entity_state_history state
    ON run.source_run_id IS NOT NULL
   AND state.business_ref_id = run.business_ref_id
   AND state.business_id = run.business_id
   AND state.provider_account_ref_id = run.provider_account_ref_id
   AND state.provider_account_id = run.provider_account_id
   AND state.entity_type = 'ad'
   AND state.presence = 'present'
   AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
   -- Entity observed_at is provider updated_time; capture time defines manifest membership.
   AND state.captured_at >= run.source_captured_at
   AND state.observed_at <= $3::timestamptz
   AND state.captured_at <= $3::timestamptz

  UNION ALL

  SELECT
    run.provider_account_id,
    'tombstone'::text AS event_kind,
    tombstone.id,
    tombstone.entity_id,
    tombstone.observed_at,
    tombstone.captured_at,
    tombstone.created_at
  FROM complete_runs run
  INNER JOIN meta_entity_tombstones tombstone
    ON run.source_run_id IS NOT NULL
   AND tombstone.business_ref_id = run.business_ref_id
   AND tombstone.business_id = run.business_id
   AND tombstone.provider_account_ref_id = run.provider_account_ref_id
   AND tombstone.provider_account_id = run.provider_account_id
   AND tombstone.entity_type = 'ad'
   AND tombstone.reason IN ('explicit_deleted', 'explicit_not_found')
   AND tombstone.captured_at >= run.source_captured_at
   AND tombstone.observed_at <= $3::timestamptz
   AND tombstone.captured_at <= $3::timestamptz
), latest_truth AS (
  SELECT DISTINCT ON (provider_account_id, entity_id)
    provider_account_id,
    event_kind,
    entity_id
  FROM truth_events
  ORDER BY provider_account_id, entity_id, observed_at DESC, captured_at DESC,
    (event_kind = 'tombstone') DESC, created_at DESC, id DESC
)
SELECT
  run.business_ref_id,
  run.business_id,
  run.provider_account_ref_id,
  run.provider_account_id,
  run.source_run_id,
  run.source_observed_at::text AS source_observed_at,
  run.source_captured_at::text AS source_captured_at,
  run.source_run_hash,
  run.source_payload_hash,
  run.source_expected_row_count,
  counts.source_persisted_row_count,
  COALESCE(
    ARRAY_AGG(truth.entity_id ORDER BY truth.entity_id)
      FILTER (WHERE truth.event_kind = 'state'),
    ARRAY[]::text[]
  ) AS expected_ad_ids
FROM complete_runs run
LEFT JOIN base_counts counts ON counts.source_run_id = run.source_run_id
LEFT JOIN latest_truth truth
  ON truth.provider_account_id = run.provider_account_id
GROUP BY
  run.business_ref_id,
  run.business_id,
  run.provider_account_ref_id,
  run.provider_account_id,
  run.source_run_id,
  run.source_observed_at,
  run.source_captured_at,
  run.source_run_hash,
  run.source_payload_hash,
  run.source_expected_row_count,
  counts.source_persisted_row_count
ORDER BY run.provider_account_id
`;

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
frequency_population AS (
  SELECT
    d.creative_id,
    AVG(d.frequency) FILTER (WHERE d.frequency > 0) AS frequency
  FROM meta_creative_daily d
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
  GROUP BY d.creative_id
),
frequency_benchmark AS (
  SELECT
    CASE WHEN COUNT(*) >= ${MIN_CAMPAIGN_CALIBRATION_SAMPLE}
      THEN percentile_cont(${FATIGUE_FREQUENCY_PRESSURE_QUANTILE})
        WITHIN GROUP (ORDER BY frequency)
    END AS frequency_p75
  FROM frequency_population
  WHERE frequency IS NOT NULL
    AND frequency > 0
),
decision_context_sources AS (
  -- Keep every positive-spend context from the exact 28d metric source. The
  -- engine must not attach one latest campaign/adset identity to a mixed rollup.
  SELECT
    d.creative_id,
    NULLIF(BTRIM(d.provider_account_id), '') AS provider_account_id,
    NULLIF(BTRIM(d.campaign_id), '') AS campaign_id,
    NULLIF(BTRIM(d.adset_id), '') AS adset_id,
    COALESCE(
      NULLIF(BTRIM(a.optimization_goal), ''),
      NULLIF(BTRIM(d.optimization_goal), '')
    ) AS optimization_goal,
    COALESCE(
      NULLIF(BTRIM(a.custom_event_type), ''),
      NULLIF(BTRIM(d.payload_json->>'customEventType'), ''),
      NULLIF(BTRIM(d.payload_json->>'custom_event_type'), '')
    ) AS custom_event_type,
    NULLIF(BTRIM(d.objective), '') AS objective,
    d.spend
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  LEFT JOIN meta_adset_daily a
    ON a.business_ref_id = d.business_ref_id
   AND a.provider_account_id = d.provider_account_id
   AND a.date = d.date
   AND a.adset_id = d.adset_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
    AND d.spend > 0
),
context_grain AS (
  SELECT
    creative_id,
    COUNT(DISTINCT provider_account_id) AS provider_account_count,
    COUNT(DISTINCT campaign_id) AS campaign_count,
    COUNT(DISTINCT adset_id) AS adset_count,
    COUNT(DISTINCT (optimization_goal, custom_event_type)) FILTER (
      WHERE optimization_goal IS NOT NULL OR custom_event_type IS NOT NULL
    ) AS optimization_context_count,
    COUNT(DISTINCT objective) AS objective_count,
    BOOL_OR(
      provider_account_id IS NULL
      OR campaign_id IS NULL
      OR adset_id IS NULL
      OR (optimization_goal IS NULL AND custom_event_type IS NULL)
      OR objective IS NULL
    ) AS context_identity_unknown
  FROM decision_context_sources
  GROUP BY creative_id
),
cohort_sources AS (
  SELECT
    creative_id,
    optimization_goal,
    custom_event_type,
    SUM(spend) AS spend
  FROM decision_context_sources
  GROUP BY
    creative_id,
    optimization_goal,
    custom_event_type
),
cohort_inputs AS (
  SELECT
    creative_id,
    jsonb_agg(
      jsonb_build_object(
        'spend', spend,
        'optimizationGoal', optimization_goal,
        'customEventType', custom_event_type
      )
    ) AS effective_cohort_inputs
  FROM cohort_sources
  GROUP BY creative_id
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
recent_24h AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.impressions) AS impressions
  FROM meta_creative_daily d
  INNER JOIN selected_creatives s ON s.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date = $2::date
  GROUP BY d.creative_id
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.effective_status,
    d.objective,
    d.campaign_id,
    d.creative_name,
    d.first_seen_at,
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
    COALESCE(
      NULLIF(d.payload_json->>'policy_reason', ''),
      NULLIF(d.payload_json->>'ad_review_feedback', ''),
      NULLIF(d.payload_json->>'review_feedback', '')
    ) AS policy_reason,
    COALESCE(
      NULLIF(d.payload_json->>'review_status', ''),
      NULLIF(d.payload_json->>'ad_review_status', ''),
      NULLIF(d.payload_json->>'approval_status', '')
    ) AS review_status,
    COALESCE(
      NULLIF(d.payload_json->>'disapproval_reason', ''),
      NULLIF(d.payload_json->>'ad_review_feedback', ''),
      NULLIF(d.payload_json->>'review_feedback', '')
    ) AS disapproval_reason,
    COALESCE(
      NULLIF(d.payload_json->>'limited_reason', ''),
      NULLIF(d.payload_json->>'delivery_info', ''),
      NULLIF(d.payload_json->>'delivery_status_reason', '')
    ) AS limited_reason,
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
  SELECT
    $5::double precision AS target_roas,
    $6::double precision AS break_even_roas,
    $7::timestamptz AS target_pack_updated_at
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
      ('prior14', d.date BETWEEN ($2::date - INTERVAL '27 days') AND ($2::date - INTERVAL '14 days')),
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

    MAX(row_count) FILTER (WHERE window_key = 'prior14') AS prior14_row_count,
    MAX(spend) FILTER (WHERE window_key = 'prior14') AS prior14_spend,
    MAX(ctr) FILTER (WHERE window_key = 'prior14') AS prior14_ctr,
    MAX(roas) FILTER (WHERE window_key = 'prior14') AS prior14_roas,
    MAX(click_to_purchase_rate) FILTER (WHERE window_key = 'prior14') AS prior14_click_to_purchase_rate,
    MAX(purchases) FILTER (WHERE window_key = 'prior14') AS prior14_purchases,

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
  fb.frequency_p75 AS frequency_pressure_threshold,
  r.spend AS recent_spend,
  r.purchases AS recent_purchases,
  r.impressions AS recent_impressions,
  r.roas AS recent_roas,
  r24.spend AS spend_24h,
  r24.impressions AS impressions_24h,
  m.effective_status,
  m.objective,
  ci.effective_cohort_inputs,
  cg.provider_account_count,
  cg.campaign_count,
  cg.adset_count,
  cg.optimization_context_count,
  cg.objective_count,
  cg.context_identity_unknown,
  m.campaign_id,
  m.creative_name,
  m.first_seen_at,
  m.first_spend_at,
  m.review_status,
  m.policy_reason,
  m.disapproval_reason,
  m.limited_reason,
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
  tp.target_pack_updated_at,
  h.last14_row_count,
  h.last14_spend,
  h.last14_ctr,
  h.last14_roas,
  h.last14_click_to_purchase_rate,
  h.last14_purchases,
  h.prior14_row_count,
  h.prior14_spend,
  h.prior14_ctr,
  h.prior14_roas,
  h.prior14_click_to_purchase_rate,
  h.prior14_purchases,
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
CROSS JOIN frequency_benchmark fb
LEFT JOIN recent r USING (creative_id)
LEFT JOIN recent_24h r24 USING (creative_id)
LEFT JOIN latest_meta m USING (creative_id)
LEFT JOIN cohort_inputs ci USING (creative_id)
LEFT JOIN context_grain cg USING (creative_id)
LEFT JOIN last_spend ls USING (creative_id)
LEFT JOIN target_pack tp ON true
LEFT JOIN historical h USING (creative_id)
ORDER BY c.spend DESC, c.creative_id ASC
`;

const ACCOUNT_CALIBRATION_QUERY = `
WITH target_pack AS (
  SELECT $3::double precision AS target_roas
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

// Calibration reads are engine_version-agnostic to avoid table invalidation on
// ENGINE_VERSION bumps. Writes preserve engine_version for provenance.
const READ_ACCOUNT_CALIBRATION_QUERY = `
SELECT
  business_ref_id,
  engine_version,
  campaign_kind,
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
  AND campaign_kind = $5::text
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
    AND campaign_kind = $3::text
    AND as_of_date <= $2::date
)
SELECT
  campaign_kind,
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
  AND campaign_kind = $3::text
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
    AND l.engine_version = $5
  ORDER BY l.creative_id, l.as_of_date DESC, l.computed_at DESC
),
latest_meta AS (
  SELECT DISTINCT ON (d.creative_id)
    d.creative_id,
    d.creative_name,
    d.first_seen_at,
    d.first_spend_at,
    COALESCE(
      NULLIF(d.payload_json->>'policy_reason', ''),
      NULLIF(d.payload_json->>'ad_review_feedback', ''),
      NULLIF(d.payload_json->>'review_feedback', '')
    ) AS policy_reason,
    COALESCE(
      NULLIF(d.payload_json->>'review_status', ''),
      NULLIF(d.payload_json->>'ad_review_status', ''),
      NULLIF(d.payload_json->>'approval_status', '')
    ) AS review_status,
    COALESCE(
      NULLIF(d.payload_json->>'disapproval_reason', ''),
      NULLIF(d.payload_json->>'ad_review_feedback', ''),
      NULLIF(d.payload_json->>'review_feedback', '')
    ) AS disapproval_reason,
    COALESCE(
      NULLIF(d.payload_json->>'limited_reason', ''),
      NULLIF(d.payload_json->>'delivery_info', ''),
      NULLIF(d.payload_json->>'delivery_status_reason', '')
    ) AS limited_reason
  FROM meta_creative_daily d
  INNER JOIN lifecycle_rows l ON l.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date <= $2::date
  ORDER BY d.creative_id, d.date DESC, d.updated_at DESC
),
recent_24h AS (
  SELECT
    d.creative_id,
    SUM(d.spend) AS spend,
    SUM(d.impressions) AS impressions
  FROM meta_creative_daily d
  INNER JOIN lifecycle_rows l ON l.creative_id = d.creative_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date = $2::date
  GROUP BY d.creative_id
),
decision_context_sources AS (
  -- Recompute decision grain from the exact 28d source even when metrics come
  -- from lifecycle snapshots; lifecycle's latest context is not authoritative.
  SELECT
    d.creative_id,
    NULLIF(BTRIM(d.provider_account_id), '') AS provider_account_id,
    NULLIF(BTRIM(d.campaign_id), '') AS campaign_id,
    NULLIF(BTRIM(d.adset_id), '') AS adset_id,
    COALESCE(
      NULLIF(BTRIM(a.optimization_goal), ''),
      NULLIF(BTRIM(d.optimization_goal), '')
    ) AS optimization_goal,
    COALESCE(
      NULLIF(BTRIM(a.custom_event_type), ''),
      NULLIF(BTRIM(d.payload_json->>'customEventType'), ''),
      NULLIF(BTRIM(d.payload_json->>'custom_event_type'), '')
    ) AS custom_event_type,
    NULLIF(BTRIM(d.objective), '') AS objective,
    d.spend
  FROM meta_creative_daily d
  INNER JOIN lifecycle_rows l ON l.creative_id = d.creative_id
  LEFT JOIN meta_adset_daily a
    ON a.business_ref_id = d.business_ref_id
   AND a.provider_account_id = d.provider_account_id
   AND a.date = d.date
   AND a.adset_id = d.adset_id
  WHERE d.business_ref_id = $1::uuid
    AND d.date BETWEEN ($2::date - INTERVAL '27 days') AND $2::date
    AND d.spend > 0
),
context_grain AS (
  SELECT
    creative_id,
    COUNT(DISTINCT provider_account_id) AS provider_account_count,
    COUNT(DISTINCT campaign_id) AS campaign_count,
    COUNT(DISTINCT adset_id) AS adset_count,
    COUNT(DISTINCT (optimization_goal, custom_event_type)) FILTER (
      WHERE optimization_goal IS NOT NULL OR custom_event_type IS NOT NULL
    ) AS optimization_context_count,
    COUNT(DISTINCT objective) AS objective_count,
    BOOL_OR(
      provider_account_id IS NULL
      OR campaign_id IS NULL
      OR adset_id IS NULL
      OR (optimization_goal IS NULL AND custom_event_type IS NULL)
      OR objective IS NULL
    ) AS context_identity_unknown
  FROM decision_context_sources
  GROUP BY creative_id
),
cohort_sources AS (
  SELECT
    creative_id,
    optimization_goal,
    custom_event_type,
    SUM(spend) AS spend
  FROM decision_context_sources
  GROUP BY
    creative_id,
    optimization_goal,
    custom_event_type
),
cohort_inputs AS (
  SELECT
    creative_id,
    jsonb_agg(
      jsonb_build_object(
        'spend', spend,
        'optimizationGoal', optimization_goal,
        'customEventType', custom_event_type
      )
    ) AS effective_cohort_inputs
  FROM cohort_sources
  GROUP BY creative_id
),
target_pack AS (
  SELECT
    $6::double precision AS target_roas,
    $7::double precision AS break_even_roas,
    $8::timestamptz AS target_pack_updated_at
)
SELECT
  l.creative_id,
  latest_meta.creative_name,
  l.campaign_id,
  l.objective,
  ci.effective_cohort_inputs,
  cg.provider_account_count,
  cg.campaign_count,
  cg.adset_count,
  cg.optimization_context_count,
  cg.objective_count,
  cg.context_identity_unknown,
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
  r24.spend AS spend_24h,
  r24.impressions AS impressions_24h,
  l.effective_status,
  l.age_days,
  COALESCE(latest_meta.first_seen_at::text, l.first_seen_date::text) AS first_seen_at,
  latest_meta.first_spend_at,
  l.last_active_date,
  latest_meta.review_status,
  latest_meta.policy_reason,
  latest_meta.disapproval_reason,
  latest_meta.limited_reason,
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
  target_pack.break_even_roas,
  target_pack.target_pack_updated_at
FROM lifecycle_rows l
LEFT JOIN latest_meta USING (creative_id)
LEFT JOIN recent_24h r24 USING (creative_id)
LEFT JOIN cohort_inputs ci USING (creative_id)
LEFT JOIN context_grain cg USING (creative_id)
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
  AND engine_version = $3
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
  AND engine_version = $4
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
  default_risk_posture,
  effective_at AS updated_at
FROM (
  SELECT *
  FROM business_target_pack_history
  WHERE business_id = $1::uuid
    AND effective_at <= $2::timestamptz
    AND recorded_at <= $2::timestamptz
  ORDER BY effective_at DESC, recorded_at DESC, id DESC
  LIMIT 1
) target_history
WHERE operation = 'upsert'
`;

const READ_DECISION_CALIBRATION_PROFILE_QUERY = `
SELECT
  engine_preset_label,
  zero_conv_burner_multiplier,
  cut_candidate_multiplier,
  sustained_loser_multiplier,
  hard_cut_multiplier,
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

function toMetaFunnelCohort(value: unknown): MetaFunnelCohort | null {
  const text = toStringOrNull(value);
  return text !== null && META_FUNNEL_COHORTS.has(text as MetaFunnelCohort)
    ? (text as MetaFunnelCohort)
    : null;
}

export function resolveEffectiveCreativeCohort(
  rows: Array<{
    spend: number | null | undefined;
    optimizationGoal?: string | null;
    customEventType?: string | null;
  }>,
): MetaFunnelCohort | null {
  const cohorts = new Set<MetaFunnelCohort>();
  let hasPositiveSpend = false;

  for (const row of rows) {
    const spend = row.spend ?? 0;
    if (!Number.isFinite(spend) || spend <= 0) continue;

    hasPositiveSpend = true;
    cohorts.add(
      resolveMetaFunnelCohort({
        optimizationGoal: row.optimizationGoal,
        customEventType: row.customEventType,
      }),
    );
  }

  if (!hasPositiveSpend || cohorts.size === 0) return null;
  if (cohorts.size > 1) return "unknown";
  return cohorts.values().next().value ?? "unknown";
}

function toEffectiveCreativeCohort(value: unknown): MetaFunnelCohort | null {
  const directCohort = toMetaFunnelCohort(value);
  if (directCohort !== null) return directCohort;

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed)) return null;

  const rows = parsed.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return [
      {
        spend: toNumberOrNull(record.spend),
        optimizationGoal: toStringOrNull(
          record.optimizationGoal ?? record.optimization_goal,
        ),
        customEventType: toStringOrNull(
          record.customEventType ?? record.custom_event_type,
        ),
      },
    ];
  });

  return resolveEffectiveCreativeCohort(rows);
}

function toCreativeDecisionContextGrain(
  row: Pick<
    CreativeHydrationRow,
    | "provider_account_count"
    | "campaign_count"
    | "adset_count"
    | "optimization_context_count"
    | "objective_count"
    | "context_identity_unknown"
  >,
): NonNullable<CreativeInput["contextGrain"]> {
  const rawCounts = [
    toIntegerOrNull(row.provider_account_count),
    toIntegerOrNull(row.campaign_count),
    toIntegerOrNull(row.adset_count),
    toIntegerOrNull(row.optimization_context_count),
    toIntegerOrNull(row.objective_count),
  ] as const;
  const malformedCount = rawCounts.some((count) => count === null || count < 0);
  const [
    providerAccountCount,
    campaignCount,
    adsetCount,
    optimizationContextCount,
    objectiveCount,
  ] = rawCounts.map((count) => (count !== null && count >= 0 ? count : 0));

  return {
    providerAccountCount,
    campaignCount,
    adsetCount,
    optimizationContextCount,
    objectiveCount,
    contextIdentityUnknown:
      malformedCount ||
      row.context_identity_unknown == null ||
      toBoolean(row.context_identity_unknown),
  };
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

function toCalibrationCampaignKind(
  value: unknown,
): CalibrationCampaignKind | null {
  const text = toStringOrNull(value);
  return text !== null &&
    CALIBRATION_CAMPAIGN_KINDS.includes(text as CalibrationCampaignKind)
    ? (text as CalibrationCampaignKind)
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

function resolveTargetReferenceTime(asOf?: string): Date | null {
  if (asOf === undefined) return new Date();
  const normalized = asOf.trim();
  if (!normalized) return null;
  const referenceTime = /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? new Date(`${normalized}T03:00:00.000Z`)
    : new Date(normalized);
  return Number.isFinite(referenceTime.getTime()) ? referenceTime : null;
}

function toCampaignObjective(value: unknown): CampaignObjective | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return CAMPAIGN_OBJECTIVES.has(text as CampaignObjective)
    ? (text as CampaignObjective)
    : null;
}

export function toEffectiveStatus(value: unknown): EffectiveStatus {
  const text = toStringOrNull(value)?.toUpperCase();
  if (text === undefined || text === null) return null;
  // Meta hierarchy statuses: the ad itself is not delivering because a parent
  // is paused. For decision semantics (PAUSED advisory badges) that IS paused;
  // dropping them to null silently exempted those rows from
  // resume_candidate/confirm_kill advisories.
  if (text === "CAMPAIGN_PAUSED" || text === "ADSET_PAUSED") return "PAUSED";
  return EFFECTIVE_STATUSES.has(text as NonNullable<EffectiveStatus>)
    ? (text as NonNullable<EffectiveStatus>)
    : null;
}

function toFatigueStatus(value: unknown): CreativeInput["fatigueStatus"] {
  const text = toStringOrNull(value);
  if (text === null) return null;
  return FATIGUE_STATUSES.has(
    text as NonNullable<CreativeInput["fatigueStatus"]>,
  )
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
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
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

function normalizedIdentityList(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}

function hasDuplicateIdentity(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function isSha256(value: string | null): value is string {
  return value !== null && /^[0-9a-f]{64}$/.test(value);
}

export function hashAdDecisionIdentityManifest(input: {
  businessId: string;
  providerAccountId: string;
  asOfDate: string;
  adIds: readonly string[];
}): string {
  const adIds = normalizedIdentityList(input.adIds);
  if (hasDuplicateIdentity(adIds)) {
    throw new TypeError("Ad identity manifest contains duplicate IDs.");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        asOfDate: input.asOfDate,
        adIds,
      }),
    )
    .digest("hex");
}

function mapAdHydrationSourceReceipt(input: {
  row: AdHydrationReceiptRow;
  businessId: string;
  asOf: string;
  decisionCutoff: string;
}): AdDecisionHydrationReceipt {
  const businessRefId = toStringOrNull(input.row.business_ref_id);
  const businessDisplayId = toStringOrNull(input.row.business_id);
  const providerAccountRefId = toStringOrNull(
    input.row.provider_account_ref_id,
  );
  const providerAccountId = toStringOrNull(input.row.provider_account_id);
  if (
    businessRefId !== input.businessId ||
    businessDisplayId !== input.businessId ||
    providerAccountRefId === null ||
    providerAccountId === null
  ) {
    throw new Error("Ad hydration receipt tenant/account lineage is invalid.");
  }
  const rawExpectedAdIds = normalizedIdentityList(
    toStringArray(input.row.expected_ad_ids),
  );
  const duplicateIdentity = hasDuplicateIdentity(rawExpectedAdIds);
  const expectedAdIds = duplicateIdentity
    ? Array.from(new Set(rawExpectedAdIds)).sort()
    : rawExpectedAdIds;
  const sourceRunId = toStringOrNull(input.row.source_run_id);
  const sourceObservedAt = toIsoTimestampOrNull(input.row.source_observed_at);
  const sourceCapturedAt = toIsoTimestampOrNull(input.row.source_captured_at);
  const sourceRunHash = toStringOrNull(input.row.source_run_hash);
  const sourceExpectedRowCount = toIntegerOrNull(
    input.row.source_expected_row_count,
  );
  const sourcePersistedRowCount = toIntegerOrNull(
    input.row.source_persisted_row_count,
  );
  const sourceComplete =
    sourceRunId !== null &&
    sourceObservedAt !== null &&
    sourceCapturedAt !== null &&
    isSha256(sourceRunHash) &&
    sourceExpectedRowCount !== null &&
    sourceExpectedRowCount >= 0 &&
    sourcePersistedRowCount === sourceExpectedRowCount &&
    !duplicateIdentity;
  const expectedManifestHash = hashAdDecisionIdentityManifest({
    businessId: input.businessId,
    providerAccountId,
    asOfDate: input.asOf,
    adIds: expectedAdIds,
  });
  return {
    contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
    businessId: input.businessId,
    providerAccountRefId,
    providerAccountId,
    scopeType: "account",
    scopeId: providerAccountId,
    asOfDate: input.asOf,
    decisionCutoff: input.decisionCutoff,
    sourceRunId,
    sourceObservedAt,
    sourceCapturedAt,
    sourceRunHash,
    sourcePayloadHash: toStringOrNull(input.row.source_payload_hash),
    sourceExpectedRowCount,
    sourcePersistedRowCount,
    expectedAdCount: expectedAdIds.length,
    expectedAdIds,
    expectedManifestHash,
    hydratedAdCount: 0,
    hydratedManifestHash: hashAdDecisionIdentityManifest({
      businessId: input.businessId,
      providerAccountId,
      asOfDate: input.asOf,
      adIds: [],
    }),
    sourceComplete,
    hydrationComplete: false,
    authoritativeForPrune: false,
    reason: sourceComplete
      ? null
      : duplicateIdentity
        ? "duplicate_expected_identity"
        : sourceRunId === null
          ? "complete_source_run_missing"
          : "complete_source_run_count_or_hash_invalid",
  };
}

function finalizeAdHydrationReceipts(input: {
  sourceReceipts: AdDecisionHydrationReceipt[];
  inputs: AdDecisionInput[];
  businessId: string;
  asOf: string;
  decisionCutoff: string;
  adIdentityFilterApplied: boolean;
}): AdDecisionHydrationReceipt[] {
  const accountKey = (
    providerAccountRefId: string,
    providerAccountId: string,
  ) => `${providerAccountRefId}\u0000${providerAccountId}`;
  const byAccount = new Map<string, AdDecisionHydrationReceipt>();
  for (const receipt of input.sourceReceipts) {
    const key = accountKey(
      receipt.providerAccountRefId,
      receipt.providerAccountId,
    );
    if (byAccount.has(key)) {
      throw new Error(
        `Duplicate ad hydration receipt for ${receipt.providerAccountRefId}/${receipt.providerAccountId}.`,
      );
    }
    byAccount.set(key, receipt);
  }
  const hydratedByAccount = new Map<string, string[]>();
  for (const ad of input.inputs) {
    const key = accountKey(ad.providerAccountRefId, ad.providerAccountId);
    const ids = hydratedByAccount.get(key) ?? [];
    ids.push(ad.adId);
    hydratedByAccount.set(key, ids);
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
        businessId: input.businessId,
        providerAccountRefId: ad.providerAccountRefId,
        providerAccountId: ad.providerAccountId,
        scopeType: "account",
        scopeId: ad.providerAccountId,
        asOfDate: input.asOf,
        decisionCutoff: input.decisionCutoff,
        sourceRunId: null,
        sourceObservedAt: null,
        sourceCapturedAt: null,
        sourceRunHash: null,
        sourcePayloadHash: null,
        sourceExpectedRowCount: null,
        sourcePersistedRowCount: null,
        expectedAdCount: 0,
        expectedAdIds: [],
        expectedManifestHash: hashAdDecisionIdentityManifest({
          businessId: input.businessId,
          providerAccountId: ad.providerAccountId,
          asOfDate: input.asOf,
          adIds: [],
        }),
        hydratedAdCount: 0,
        hydratedManifestHash: "",
        sourceComplete: false,
        hydrationComplete: false,
        authoritativeForPrune: false,
        reason: "account_receipt_missing",
      });
    }
  }
  return Array.from(byAccount.values())
    .map((receipt) => {
      const hydratedAdIds = normalizedIdentityList(
        hydratedByAccount.get(
          accountKey(receipt.providerAccountRefId, receipt.providerAccountId),
        ) ?? [],
      );
      if (hasDuplicateIdentity(hydratedAdIds)) {
        throw new Error(
          `Duplicate hydrated ad identity for ${receipt.providerAccountId}.`,
        );
      }
      const hydratedManifestHash = hashAdDecisionIdentityManifest({
        businessId: input.businessId,
        providerAccountId: receipt.providerAccountId,
        asOfDate: input.asOf,
        adIds: hydratedAdIds,
      });
      const hydrationComplete =
        receipt.sourceComplete &&
        hydratedAdIds.length === receipt.expectedAdCount &&
        hydratedManifestHash === receipt.expectedManifestHash;
      const authoritativeForPrune =
        hydrationComplete && !input.adIdentityFilterApplied;
      return {
        ...receipt,
        hydratedAdCount: hydratedAdIds.length,
        hydratedManifestHash,
        hydrationComplete,
        authoritativeForPrune,
        reason: authoritativeForPrune
          ? null
          : input.adIdentityFilterApplied
            ? "ad_identity_filter_applied"
            : (receipt.reason ?? "hydrated_manifest_mismatch"),
      };
    })
    .sort(
      (left, right) =>
        left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    );
}

function requireAdDecisionAsOf(value: string): string {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new TypeError("asOf must be an ISO date (YYYY-MM-DD).");
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new TypeError("asOf must be a valid calendar date.");
  }
  return normalized;
}

function requireDecisionCutoff(value: string, asOf: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError("decisionCutoff must be a valid timestamp.");
  }
  const normalized = parsed.toISOString();
  if (normalized.slice(0, 10) < asOf) {
    throw new TypeError("decisionCutoff cannot precede asOf.");
  }
  return normalized;
}

function normalizeOptionalIdentityFilter(values: string[] | undefined) {
  if (values === undefined) return undefined;
  return Array.from(
    new Set(values.map((value) => value.trim()).filter(Boolean)),
  ).sort();
}

export function isPresentDayAdDecisionAsOf(
  asOf: string,
  decisionCutoff: string,
  now: Date = new Date(),
): boolean {
  const cutoff = new Date(decisionCutoff);
  if (Number.isNaN(cutoff.getTime()) || Number.isNaN(now.getTime()))
    return false;
  const today = now.toISOString().slice(0, 10);
  return asOf === today && cutoff.toISOString().slice(0, 10) === today;
}

function adDecisionIdentityKey(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
}) {
  return `${input.businessId}\u0000${input.providerAccountRefId}\u0000${input.providerAccountId}\u0000${input.adId}`;
}

function dateDistanceDays(asOf: string, earlier: string | null) {
  if (earlier === null || earlier > asOf) return null;
  const end = new Date(`${asOf}T00:00:00.000Z`).getTime();
  const start = new Date(`${earlier}T00:00:00.000Z`).getTime();
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.floor((end - start) / 86_400_000);
}

interface MappedAdDecisionInput {
  input: AdDecisionInput;
  currentDimensionId: string | null;
  currentDimensionStatus: EffectiveStatus;
}

function mapAdDecisionHydrationRow(input: {
  row: AdDecisionHydrationRow;
  businessId: string;
  asOf: string;
  decisionCutoff: string;
}): MappedAdDecisionInput {
  const allowCurrentDimensions = isPresentDayAdDecisionAsOf(
    input.asOf,
    input.decisionCutoff,
  );
  const providerAccountRefId = toStringOrNull(
    input.row.provider_account_ref_id,
  );
  const providerAccountId = toStringOrNull(input.row.provider_account_id);
  const adId = toStringOrNull(input.row.ad_id);
  if (
    providerAccountRefId === null ||
    providerAccountId === null ||
    adId === null
  ) {
    throw new Error(
      "Ad decision hydration returned a row without native identity.",
    );
  }

  const campaignCount = toIntegerOrNull(input.row.campaign_count) ?? 0;
  const adsetCount = toIntegerOrNull(input.row.adset_count) ?? 0;
  const optimizationContextCount =
    toIntegerOrNull(input.row.optimization_context_count) ?? 0;
  const objectiveCount = toIntegerOrNull(input.row.objective_count) ?? 0;
  const contextIdentityUnknown =
    toBoolean(input.row.context_identity_unknown) ||
    campaignCount !== 1 ||
    adsetCount !== 1 ||
    optimizationContextCount !== 1 ||
    objectiveCount !== 1;
  const metricRowCount = Math.max(
    0,
    toIntegerOrNull(input.row.metric_row_count) ?? 0,
  );
  const objective = contextIdentityUnknown
    ? null
    : toCampaignObjective(input.row.objective);
  const optimizationGoal = contextIdentityUnknown
    ? null
    : toStringOrNull(input.row.optimization_goal);
  const customEventType = contextIdentityUnknown
    ? null
    : toStringOrNull(input.row.custom_event_type);
  const conversions = toNumberOrNull(input.row.conversions) ?? 0;
  const revenue = toNumberOrNull(input.row.revenue) ?? 0;
  const effectiveCohort = contextIdentityUnknown
    ? "unknown"
    : resolveMetaFunnelCohort({
        optimizationGoal,
        customEventType,
        objective,
        purchases: conversions,
        revenue,
      });
  const isPurchase = effectiveCohort === "purchase";
  const recentConversions = toNumberOrNull(input.row.recent_conversions) ?? 0;
  const lifecyclePosition = allowCurrentDimensions
    ? toLifecyclePosition(input.row.lifecycle_position)
    : null;
  const daysSincePeak = allowCurrentDimensions
    ? toIntegerOrNull(input.row.days_since_peak)
    : null;
  const peakRoas30d = allowCurrentDimensions
    ? toNumberOrNull(input.row.peak_roas_30d)
    : null;
  const peakConfidence = allowCurrentDimensions
    ? toNumberOrNull(input.row.peak_confidence)
    : null;
  const spendTrajectory30d = allowCurrentDimensions
    ? toSpendTrajectory(input.row.spend_trajectory_30d)
    : null;
  const spendSlope7d = allowCurrentDimensions
    ? toNumberOrNull(input.row.spend_slope_7d)
    : null;
  const spendSlope30d = allowCurrentDimensions
    ? toNumberOrNull(input.row.spend_slope_30d)
    : null;
  const roasSlope7d = allowCurrentDimensions
    ? toNumberOrNull(input.row.roas_slope_7d)
    : null;
  const roasSlope30d = allowCurrentDimensions
    ? toNumberOrNull(input.row.roas_slope_30d)
    : null;
  const fatigueStatus = allowCurrentDimensions
    ? toFatigueStatus(input.row.fatigue_status)
    : null;
  const qualityRanking = allowCurrentDimensions
    ? toMetaRanking(input.row.quality_ranking)
    : null;
  const engagementRateRanking = allowCurrentDimensions
    ? toMetaRanking(input.row.engagement_rate_ranking)
    : null;
  const conversionRateRanking = allowCurrentDimensions
    ? toMetaRanking(input.row.conversion_rate_ranking)
    : null;
  const creativeFormat = allowCurrentDimensions
    ? toCreativeFormat(input.row.creative_format)
    : null;
  const firstSeenAt = allowCurrentDimensions
    ? toIsoTimestampOrNull(input.row.first_seen_at)
    : null;
  const firstSeenDate = firstSeenAt?.slice(0, 10) ?? null;

  return {
    currentDimensionId: allowCurrentDimensions
      ? toStringOrNull(input.row.current_dimension_id)
      : null,
    currentDimensionStatus: allowCurrentDimensions
      ? toEffectiveStatus(input.row.current_ad_status)
      : null,
    input: {
      decisionEntityType: "ad",
      decisionEntityId: adId,
      adId,
      providerAccountId,
      providerAccountRefId,
      accountTimezone: toStringOrNull(input.row.account_timezone),
      accountCurrency: toStringOrNull(input.row.account_currency),
      adsetId: contextIdentityUnknown
        ? null
        : toStringOrNull(input.row.adset_id),
      creativeId: allowCurrentDimensions
        ? toStringOrNull(input.row.creative_id)
        : null,
      creativeName:
        (allowCurrentDimensions
          ? toStringOrNull(input.row.creative_name)
          : null) ?? toStringOrNull(input.row.ad_name),
      businessId: input.businessId,
      campaignId: contextIdentityUnknown
        ? null
        : toStringOrNull(input.row.campaign_id),
      optimizationGoal,
      customEventType,
      metricEvidence: {
        sourceRowCount: metricRowCount,
        performanceMetricsObserved: metricRowCount > 0,
        eventMetricsObserved:
          metricRowCount > 0 && toBoolean(input.row.event_metrics_observed),
      },
      objective,
      contextGrain: {
        providerAccountCount: 1,
        campaignCount,
        adsetCount,
        optimizationContextCount,
        objectiveCount,
        contextIdentityUnknown,
      },
      effectiveCohort,
      spend: toNumberOrNull(input.row.spend) ?? 0,
      purchases: isPurchase ? conversions : 0,
      purchaseValue: isPurchase ? revenue : null,
      impressions: toNumberOrNull(input.row.impressions),
      linkClicks: toNumberOrNull(input.row.link_clicks),
      roas: isPurchase ? toNumberOrNull(input.row.roas) : null,
      cpa: isPurchase ? toNumberOrNull(input.row.cpa) : null,
      ctr: toNumberOrNull(input.row.ctr),
      frequency: toNumberOrNull(input.row.frequency),
      recent7dSpend: toNumberOrNull(input.row.recent_spend),
      recent7dPurchases: isPurchase ? recentConversions : 0,
      recent7dRoas: isPurchase ? toNumberOrNull(input.row.recent_roas) : null,
      recent7dImpressions: toNumberOrNull(input.row.recent_impressions),
      effectiveStatus: null,
      ageDays: dateDistanceDays(input.asOf, firstSeenDate),
      firstSeenAt,
      firstSpendAt: toIsoDateOrNull(input.row.first_spend_at),
      lastSpendAt: toIsoDateOrNull(input.row.last_spend_date),
      spend24h: toNumberOrNull(input.row.spend_24h),
      impressions24h: toNumberOrNull(input.row.impressions_24h),
      reviewStatus: null,
      policyReason: null,
      disapprovalReason: null,
      limitedReason: null,
      dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
      fatigueStatus,
      targetRoas: toNumberOrNull(input.row.target_roas),
      breakevenRoas: toNumberOrNull(input.row.break_even_roas),
      commercialTargetFreshness: resolveBusinessTargetPackFreshness(
        toIsoTimestampOrNull(input.row.target_pack_updated_at),
        new Date(input.decisionCutoff),
      ),
      lifecyclePosition,
      daysSincePeak,
      peakRoas30d,
      peakConfidence,
      spendTrajectory30d,
      spendSlope7d,
      spendSlope30d,
      roasSlope7d,
      roasSlope30d,
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
      qualityRanking,
      engagementRateRanking,
      conversionRateRanking,
      creativeFormat,
      statusEvidence: {
        source: "missing",
        sourceRecordId: null,
        observedAt: null,
        capturedAt: null,
      },
      creativeEvidence: {
        sourceLifecycleRowId: allowCurrentDimensions
          ? toStringOrNull(input.row.lifecycle_row_id)
          : null,
        sourceAsOfDate: allowCurrentDimensions
          ? toIsoDateOrNull(input.row.lifecycle_as_of_date)
          : null,
        sourceComputedAt: allowCurrentDimensions
          ? toIsoTimestampOrNull(input.row.lifecycle_computed_at)
          : null,
        sourceMaxUpdatedAt: allowCurrentDimensions
          ? toIsoTimestampOrNull(input.row.lifecycle_source_max_updated_at)
          : null,
        lifecyclePosition,
        daysSincePeak,
        peakRoas30d,
        peakConfidence,
        spendTrajectory30d,
        spendSlope7d,
        spendSlope30d,
        roasSlope7d,
        roasSlope30d,
        fatigueStatus,
        qualityRanking,
        engagementRateRanking,
        conversionRateRanking,
        creativeFormat,
      },
    },
  };
}

function policyReasonFromState(row: AdEntityStateRow) {
  const policyStatus = toStringOrNull(row.policy_status);
  if (policyStatus !== null) return policyStatus;
  const reasons = toStringArray(row.policy_reasons_json);
  return reasons.length > 0 ? reasons.join("; ") : null;
}

function applyAdStatusEvidence(input: {
  mapped: MappedAdDecisionInput;
  state: AdEntityStateRow | undefined;
  allowCurrentDimensionFallback: boolean;
}): AdDecisionInput {
  if (input.state) {
    const stateProviderAccountRefId = toStringOrNull(
      input.state.provider_account_ref_id,
    );
    if (
      stateProviderAccountRefId !== null &&
      stateProviderAccountRefId !== input.mapped.input.providerAccountRefId
    ) {
      throw new Error(
        `Ad state account lineage mismatch for ${input.mapped.input.providerAccountId}/${input.mapped.input.adId}.`,
      );
    }
    if (input.state.event_kind === "tombstone") {
      return {
        ...input.mapped.input,
        creativeId: null,
        effectiveStatus: "DELETED",
        reviewStatus: null,
        policyReason: toStringOrNull(input.state.tombstone_reason),
        statusEvidence: {
          source: "entity_tombstone",
          sourceRecordId: toStringOrNull(input.state.id),
          observedAt: toIsoTimestampOrNull(input.state.observed_at),
          capturedAt: toIsoTimestampOrNull(input.state.captured_at),
        },
      };
    }
    return {
      ...input.mapped.input,
      creativeId:
        toStringOrNull(input.state.creative_id) ??
        input.mapped.input.creativeId,
      effectiveStatus: toEffectiveStatus(
        input.state.effective_status ?? input.state.configured_status,
      ),
      reviewStatus: toStringOrNull(input.state.review_status),
      policyReason: policyReasonFromState(input.state),
      statusEvidence: {
        source: "entity_state_history",
        sourceRecordId: toStringOrNull(input.state.id),
        observedAt: toIsoTimestampOrNull(input.state.observed_at),
        capturedAt: toIsoTimestampOrNull(input.state.captured_at),
      },
    };
  }
  if (
    input.allowCurrentDimensionFallback &&
    input.mapped.currentDimensionStatus !== null
  ) {
    return {
      ...input.mapped.input,
      effectiveStatus: input.mapped.currentDimensionStatus,
      statusEvidence: {
        source: "current_dimension",
        sourceRecordId: input.mapped.currentDimensionId,
        observedAt: null,
        capturedAt: null,
      },
    };
  }
  return input.mapped.input;
}

function isUndefinedTableError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    String((error as { code?: unknown }).code ?? "") === "42P01"
  );
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
  asOf: string;
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
      prior14: toHistoricalWindow(input.row, "prior14"),
      last30: toHistoricalWindow(input.row, "last30"),
      last90: toHistoricalWindow(input.row, "last90"),
      allHistory: toHistoricalWindow(input.row, "all_history"),
    },
    spendConcentration: null,
    frequency,
    frequencyPressureThreshold: toNumberOrNull(
      input.row.frequency_pressure_threshold,
    ),
    benchmarkRoasStatus: null,
    benchmarkClickToPurchaseStatus: null,
  });

  return {
    creativeId,
    creativeName: toStringOrNull(input.row.creative_name),
    businessId: input.businessId,
    campaignId: toStringOrNull(input.row.campaign_id),
    objective: toCampaignObjective(input.row.objective),
    contextGrain: toCreativeDecisionContextGrain(input.row),
    effectiveCohort: toEffectiveCreativeCohort(
      input.row.effective_cohort_inputs,
    ),
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
    firstSeenAt: toIsoTimestampOrNull(input.row.first_seen_at),
    firstSpendAt: toIsoTimestampOrNull(input.row.first_spend_at),
    lastSpendAt: toIsoDateOrNull(input.row.last_spend_date),
    spend24h: toNumberOrNull(input.row.spend_24h),
    impressions24h: toNumberOrNull(input.row.impressions_24h),
    reviewStatus: toStringOrNull(input.row.review_status),
    policyReason: toStringOrNull(input.row.policy_reason),
    disapprovalReason: toStringOrNull(input.row.disapproval_reason),
    limitedReason: toStringOrNull(input.row.limited_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: fatigue.status,
    targetRoas,
    breakevenRoas,
    commercialTargetFreshness: resolveBusinessTargetPackFreshness(
      toIsoTimestampOrNull(input.row.target_pack_updated_at),
      resolveTargetReferenceTime(input.asOf) ?? new Date(Number.NaN),
    ),
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
  asOf: string;
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
    contextGrain: toCreativeDecisionContextGrain(input.row),
    effectiveCohort: toEffectiveCreativeCohort(
      input.row.effective_cohort_inputs,
    ),
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
    firstSeenAt: toIsoTimestampOrNull(input.row.first_seen_at),
    firstSpendAt: toIsoTimestampOrNull(input.row.first_spend_at),
    lastSpendAt: toIsoDateOrNull(input.row.last_active_date),
    spend24h: toNumberOrNull(input.row.spend_24h),
    impressions24h: toNumberOrNull(input.row.impressions_24h),
    reviewStatus: toStringOrNull(input.row.review_status),
    policyReason: toStringOrNull(input.row.policy_reason),
    disapprovalReason: toStringOrNull(input.row.disapproval_reason),
    limitedReason: toStringOrNull(input.row.limited_reason),
    dataFreshnessHours: toIntegerOrNull(input.row.data_freshness_hours),
    fatigueStatus: toFatigueStatus(input.row.fatigue_status),
    targetRoas: toNumberOrNull(input.row.target_roas),
    breakevenRoas: toNumberOrNull(input.row.break_even_roas),
    commercialTargetFreshness: resolveBusinessTargetPackFreshness(
      toIsoTimestampOrNull(input.row.target_pack_updated_at),
      resolveTargetReferenceTime(input.asOf) ?? new Date(Number.NaN),
    ),
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
  campaignKind: CalibrationCampaignKind = "all",
): AccountCalibration {
  return {
    businessId,
    computedAt,
    campaignKind,
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

function zeroAccountFunnelCalibration(
  campaignKind: CalibrationCampaignKind = "all",
): AccountFunnelCalibration {
  return { campaignKind, byFormat: {} };
}

function toFunnelQualityStatus(
  value: unknown,
  sampleSize: number,
): FormatFunnelBaseline["qualityStatus"] {
  const text = toStringOrNull(value);
  if (text === "ready" || text === "low_sample" || text === "insufficient") {
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

async function readAdEntityStatesInBatches(input: {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adIds: readonly string[];
  decisionCutoff: string;
  sourceCapturedAt: string | null;
}): Promise<AdEntityStateRow[]> {
  const rows: AdEntityStateRow[] = [];
  for (const adIdBatch of chunkDecisionRows(
    normalizedIdentityList(input.adIds),
  )) {
    try {
      rows.push(
        ...(await getDb().query<AdEntityStateRow>(
          READ_AD_ENTITY_STATE_AS_OF_QUERY,
          [
            input.businessId,
            input.providerAccountRefId,
            input.providerAccountId,
            adIdBatch,
            input.decisionCutoff,
            input.sourceCapturedAt,
          ],
        )),
      );
    } catch (error) {
      if (isUndefinedTableError(error)) throw error;
      throw new Error(
        `Native ad state batch failed for ${input.providerAccountId} (${adIdBatch.length} identities): ${errorMessage(error)}`,
      );
    }
  }
  return rows;
}

function addPresentAdStateSeed(
  seeds: Map<string, PresentAdStateSeedRow>,
  row: PresentAdStateSeedRow,
  businessId: string,
) {
  const rowBusinessId = toStringOrNull(row.business_id);
  const providerAccountRefId = toStringOrNull(row.provider_account_ref_id);
  const providerAccountId = toStringOrNull(row.provider_account_id);
  const adId = toStringOrNull(row.ad_id);
  if (
    rowBusinessId !== businessId ||
    providerAccountRefId === null ||
    providerAccountId === null ||
    adId === null
  ) {
    throw new Error(
      "Present ad state seed has incomplete tenant/account lineage.",
    );
  }
  const key = `${providerAccountRefId}\u0000${providerAccountId}\u0000${adId}`;
  if (seeds.has(key)) {
    throw new Error(`Duplicate present ad state seed: ${key}`);
  }
  seeds.set(key, row);
}

function presentAdStateSeedFromEntityState(
  row: AdEntityStateRow,
  businessId: string,
): PresentAdStateSeedRow | null {
  if (row.event_kind !== "state") return null;
  const providerAccountRefId = toStringOrNull(row.provider_account_ref_id);
  const providerAccountId = toStringOrNull(row.provider_account_id);
  const adId = toStringOrNull(row.entity_id);
  const capturedAt = toIsoTimestampOrNull(row.captured_at);
  if (
    providerAccountRefId === null ||
    providerAccountId === null ||
    adId === null ||
    capturedAt === null
  ) {
    throw new Error("Current ad state row cannot form a hydration seed.");
  }
  return {
    business_id: businessId,
    provider_account_ref_id: providerAccountRefId,
    provider_account_id: providerAccountId,
    ad_id: adId,
    campaign_id: toStringOrNull(row.campaign_id),
    adset_id: toStringOrNull(row.adset_id),
    creative_id: toStringOrNull(row.creative_id),
    captured_at: capturedAt,
  };
}

async function readPresentAdStateSeedsForHydration(input: {
  businessId: string;
  decisionCutoff: string;
  sourceReceipts: AdDecisionHydrationReceipt[];
  receiptQueryAvailable: boolean;
  providerAccountIds: string[] | undefined;
  adIds: string[] | undefined;
}): Promise<{
  seeds: PresentAdStateSeedRow[];
  stateRows: AdEntityStateRow[];
}> {
  const fallback = async (providerAccountIds: string[] | undefined) => {
    try {
      return await getDb().query<PresentAdStateSeedRow>(
        READ_PRESENT_AD_STATE_SEEDS_QUERY,
        [
          input.businessId,
          input.decisionCutoff,
          providerAccountIds ?? [],
          providerAccountIds !== undefined,
          input.adIds ?? [],
          input.adIds !== undefined,
        ],
      );
    } catch (error) {
      if (isUndefinedTableError(error)) return [];
      throw new Error(
        `Native ad present-state seed failed: ${errorMessage(error)}`,
      );
    }
  };
  if (!input.receiptQueryAvailable || input.sourceReceipts.length === 0) {
    return {
      seeds: await fallback(input.providerAccountIds),
      stateRows: [],
    };
  }
  const requestedAdIds =
    input.adIds === undefined ? null : new Set(input.adIds);
  const seeds = new Map<string, PresentAdStateSeedRow>();
  const completeStateRows: AdEntityStateRow[] = [];
  for (const receipt of input.sourceReceipts) {
    if (!receipt.sourceComplete) {
      const fallbackRows = await fallback([receipt.providerAccountId]);
      for (const row of fallbackRows) {
        addPresentAdStateSeed(seeds, row, input.businessId);
      }
      continue;
    }
    if (receipt.sourceCapturedAt === null) {
      throw new Error(
        `Complete native ad receipt lacks a capture boundary for ${receipt.providerAccountId}.`,
      );
    }
    const expectedAdIds = receipt.expectedAdIds.filter(
      (adId) => requestedAdIds === null || requestedAdIds.has(adId),
    );
    const stateRows = await readAdEntityStatesInBatches({
      businessId: input.businessId,
      providerAccountRefId: receipt.providerAccountRefId,
      providerAccountId: receipt.providerAccountId,
      adIds: expectedAdIds,
      decisionCutoff: input.decisionCutoff,
      sourceCapturedAt: receipt.sourceCapturedAt,
    });
    completeStateRows.push(...stateRows);
    const accountSeeds = stateRows.flatMap((row) => {
      const seed = presentAdStateSeedFromEntityState(row, input.businessId);
      return seed ? [seed] : [];
    });
    if (accountSeeds.length !== expectedAdIds.length) {
      throw new Error(
        `Complete native ad manifest/state mismatch for ${receipt.providerAccountId}: expected ${expectedAdIds.length}, resolved ${accountSeeds.length}.`,
      );
    }
    for (const seed of accountSeeds) {
      addPresentAdStateSeed(seeds, seed, input.businessId);
    }
  }
  return {
    seeds: Array.from(seeds.values()),
    stateRows: completeStateRows,
  };
}

function addAdEntityState(
  statesByIdentity: Map<string, AdEntityStateRow>,
  businessId: string,
  row: AdEntityStateRow,
) {
  const providerAccountRefId = toStringOrNull(row.provider_account_ref_id);
  const providerAccountId = toStringOrNull(row.provider_account_id);
  const adId = toStringOrNull(row.entity_id);
  if (
    providerAccountRefId === null ||
    providerAccountId === null ||
    adId === null
  )
    return;
  const key = adDecisionIdentityKey({
    businessId,
    providerAccountRefId,
    providerAccountId,
    adId,
  });
  if (statesByIdentity.has(key)) {
    throw new Error(
      `Duplicate native ad state identity: ${providerAccountId}/${adId}.`,
    );
  }
  statesByIdentity.set(key, row);
}

async function readAdHydrationRowsInBatches(input: {
  businessId: string;
  asOf: string;
  decisionCutoff: string;
  sourceReceipts: AdDecisionHydrationReceipt[];
  receiptQueryAvailable: boolean;
  providerAccountIds: string[] | undefined;
  adIds: string[] | undefined;
  targetPack: BusinessTargetPack | null;
  allowCurrentDimensionFallback: boolean;
  presentAdStateSeeds: PresentAdStateSeedRow[];
}): Promise<AdDecisionHydrationRow[]> {
  const queryRows = async (queryInput: {
    providerAccountIds: string[] | undefined;
    adIds: string[] | undefined;
    presentAdStateSeeds: PresentAdStateSeedRow[];
  }) => {
    try {
      return await getDb().query<AdDecisionHydrationRow>(
        HYDRATE_AD_DECISION_INPUTS_QUERY,
        [
          input.businessId,
          input.asOf,
          queryInput.providerAccountIds ?? [],
          queryInput.providerAccountIds !== undefined,
          queryInput.adIds ?? [],
          queryInput.adIds !== undefined,
          input.targetPack?.targetRoas ?? null,
          input.targetPack?.breakEvenRoas ?? null,
          input.targetPack?.updatedAt ?? null,
          ENGINE_VERSION,
          input.decisionCutoff,
          input.allowCurrentDimensionFallback,
          JSON.stringify(queryInput.presentAdStateSeeds),
        ],
      );
    } catch (error) {
      const accountScope = queryInput.providerAccountIds?.join(",") ?? "all";
      throw new Error(
        `Native ad hydration batch failed for ${accountScope} (${queryInput.adIds?.length ?? "unbounded"} identities): ${errorMessage(error)}`,
      );
    }
  };
  if (!input.receiptQueryAvailable || input.sourceReceipts.length === 0) {
    return queryRows({
      providerAccountIds: input.providerAccountIds,
      adIds: input.adIds,
      presentAdStateSeeds: input.presentAdStateSeeds,
    });
  }
  const requestedAdIds =
    input.adIds === undefined ? null : new Set(input.adIds);
  const rows: AdDecisionHydrationRow[] = [];
  for (const receipt of input.sourceReceipts) {
    if (!receipt.sourceComplete && requestedAdIds === null) {
      rows.push(
        ...(await queryRows({
          providerAccountIds: [receipt.providerAccountId],
          adIds: undefined,
          presentAdStateSeeds: input.presentAdStateSeeds.filter(
            (seed) =>
              toStringOrNull(seed.provider_account_ref_id) ===
                receipt.providerAccountRefId &&
              toStringOrNull(seed.provider_account_id) ===
                receipt.providerAccountId,
          ),
        })),
      );
      continue;
    }
    const candidateAdIds = (
      receipt.sourceComplete ? receipt.expectedAdIds : (input.adIds ?? [])
    ).filter((adId) => requestedAdIds === null || requestedAdIds.has(adId));
    for (const adIdBatch of chunkDecisionRows(candidateAdIds)) {
      const batchIds = new Set(adIdBatch);
      rows.push(
        ...(await queryRows({
          providerAccountIds: [receipt.providerAccountId],
          adIds: adIdBatch,
          presentAdStateSeeds: input.presentAdStateSeeds.filter(
            (seed) =>
              toStringOrNull(seed.provider_account_ref_id) ===
                receipt.providerAccountRefId &&
              toStringOrNull(seed.provider_account_id) ===
                receipt.providerAccountId &&
              batchIds.has(toStringOrNull(seed.ad_id) ?? ""),
          ),
        })),
      );
    }
  }
  return rows;
}

/**
 * Production warehouse implementation backed by meta_creative_daily and the
 * append-only business target history. The engine still consumes the same
 * CreativeInput contract as MockDataSource.
 */
export class WarehouseDataSource
  implements CreativeDecisionDataSource, AdDecisionDataSource
{
  private lastCalibrationMetadata: CalibrationReadMetadata | null = null;

  private async computeCreativeInputsViaRuntimeSql(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    const creativeIds = input.creativeIds ?? [];
    if (input.creativeIds && input.creativeIds.length === 0) return [];

    const targetPack = await this.getBusinessTargetPack({
      businessId: input.businessId,
      asOf: input.asOf,
    });

    const rows = await getDb().query<CreativeHydrationRow>(
      HYDRATE_CREATIVE_INPUTS_QUERY,
      [
        input.businessId,
        input.asOf,
        creativeIds,
        input.creativeIds != null,
        targetPack?.targetRoas ?? null,
        targetPack?.breakEvenRoas ?? null,
        targetPack?.updatedAt ?? null,
      ],
    );

    return rows
      .map((row) =>
        mapCreativeHydrationRow({
          row,
          businessId: input.businessId,
          asOf: input.asOf,
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
      const targetPack = await this.getBusinessTargetPack({
        businessId: input.businessId,
        asOf: input.asOf,
      });
      rows = await getDb().query<LifecycleTableHydrationRow>(
        READ_LIFECYCLE_CREATIVE_INPUTS_QUERY,
        [
          input.businessId,
          input.asOf,
          creativeIds,
          input.creativeIds != null,
          ENGINE_VERSION,
          targetPack?.targetRoas ?? null,
          targetPack?.breakEvenRoas ?? null,
          targetPack?.updatedAt ?? null,
        ],
      );
    } catch {
      return [];
    }

    return rows
      .map((row) =>
        mapLifecycleHydrationRow({
          row,
          businessId: input.businessId,
          asOf: input.asOf,
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

  async hydrateAdDecisionInputs(
    input: AdDecisionInputQuery,
  ): Promise<AdDecisionHydrationResult> {
    const asOf = requireAdDecisionAsOf(input.asOf);
    const decisionCutoff = requireDecisionCutoff(input.decisionCutoff, asOf);
    const providerAccountIds = normalizeOptionalIdentityFilter(
      input.providerAccountIds,
    );
    const adIds = normalizeOptionalIdentityFilter(input.adIds);
    if (providerAccountIds?.length === 0 || adIds?.length === 0) {
      return { inputs: [], receipts: [], accountCoverageComplete: false };
    }
    const allowCurrentDimensionFallback = isPresentDayAdDecisionAsOf(
      asOf,
      decisionCutoff,
    );
    let receiptRows: AdHydrationReceiptRow[] = [];
    let receiptQueryAvailable = true;
    try {
      receiptRows = await getDb().query<AdHydrationReceiptRow>(
        READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
        [
          input.businessId,
          asOf,
          decisionCutoff,
          providerAccountIds ?? [],
          providerAccountIds !== undefined,
        ],
      );
    } catch (error) {
      if (!isUndefinedTableError(error)) throw error;
      receiptQueryAvailable = false;
    }
    const sourceReceipts = receiptRows.map((row) =>
      mapAdHydrationSourceReceipt({
        row,
        businessId: input.businessId,
        asOf,
        decisionCutoff,
      }),
    );
    // A complete source receipt is cutoff-strict historical evidence, not a
    // current-dimension fallback. Seed every identity from that manifest even
    // when the scheduled decision date is yesterday; otherwise metricless or
    // paused ads disappear from hydration and the authoritative manifest can
    // never reconcile. Current SCD0 dimensions remain gated separately by
    // allowCurrentDimensionFallback below.
    const hasCompleteSourceManifest = sourceReceipts.some(
      (receipt) => receipt.sourceComplete,
    );
    const presentStateHydration =
      allowCurrentDimensionFallback || hasCompleteSourceManifest
      ? await readPresentAdStateSeedsForHydration({
          businessId: input.businessId,
          decisionCutoff,
          sourceReceipts,
          receiptQueryAvailable,
          providerAccountIds,
          adIds,
        })
      : { seeds: [], stateRows: [] };
    const presentAdStateSeeds = presentStateHydration.seeds;

    const targetPack = await this.getBusinessTargetPack({
      businessId: input.businessId,
      asOf: decisionCutoff,
    });
    const rows = await readAdHydrationRowsInBatches({
      businessId: input.businessId,
      asOf,
      decisionCutoff,
      sourceReceipts,
      receiptQueryAvailable,
      providerAccountIds,
      adIds,
      targetPack,
      allowCurrentDimensionFallback,
      presentAdStateSeeds,
    });
    const mapped = rows.map((row) =>
      mapAdDecisionHydrationRow({
        row,
        businessId: input.businessId,
        asOf,
        decisionCutoff,
      }),
    );
    const completeExpectedByAccount = new Map(
      sourceReceipts
        .filter((receipt) => receipt.sourceComplete)
        .map((receipt) => [
          `${receipt.providerAccountRefId}\u0000${receipt.providerAccountId}`,
          new Set(receipt.expectedAdIds),
        ]),
    );
    const mappedByIdentity = new Map<string, MappedAdDecisionInput>();
    for (const item of mapped) {
      const expected = completeExpectedByAccount.get(
        `${item.input.providerAccountRefId}\u0000${item.input.providerAccountId}`,
      );
      if (expected && !expected.has(item.input.adId)) continue;
      const key = adDecisionIdentityKey({
        businessId: input.businessId,
        providerAccountRefId: item.input.providerAccountRefId,
        providerAccountId: item.input.providerAccountId,
        adId: item.input.adId,
      });
      if (mappedByIdentity.has(key)) {
        throw new Error(
          `Duplicate ad decision hydration row for ${item.input.providerAccountId}/${item.input.adId}.`,
        );
      }
      mappedByIdentity.set(key, item);
    }

    const statesByIdentity = new Map<string, AdEntityStateRow>();
    for (const state of presentStateHydration.stateRows) {
      addAdEntityState(statesByIdentity, input.businessId, state);
    }
    const adIdsByAccount = new Map<
      string,
      {
        providerAccountRefId: string;
        providerAccountId: string;
        adIds: string[];
      }
    >();
    for (const item of mappedByIdentity.values()) {
      const accountKey = `${item.input.providerAccountRefId}\u0000${item.input.providerAccountId}`;
      const account = adIdsByAccount.get(accountKey) ?? {
        providerAccountRefId: item.input.providerAccountRefId,
        providerAccountId: item.input.providerAccountId,
        adIds: [],
      };
      account.adIds.push(item.input.adId);
      adIdsByAccount.set(accountKey, account);
    }
    for (const account of Array.from(adIdsByAccount.values()).sort(
      (left, right) =>
        left.providerAccountRefId.localeCompare(right.providerAccountRefId) ||
        left.providerAccountId.localeCompare(right.providerAccountId),
    )) {
      const missingAdIds = Array.from(new Set(account.adIds))
        .sort()
        .filter(
          (adId) =>
            !statesByIdentity.has(
              adDecisionIdentityKey({
                businessId: input.businessId,
                providerAccountRefId: account.providerAccountRefId,
                providerAccountId: account.providerAccountId,
                adId,
              }),
            ),
        );
      if (missingAdIds.length === 0) continue;
      let stateRows: AdEntityStateRow[];
      try {
        stateRows = await readAdEntityStatesInBatches({
          businessId: input.businessId,
          providerAccountRefId: account.providerAccountRefId,
          providerAccountId: account.providerAccountId,
          adIds: missingAdIds,
          decisionCutoff,
          sourceCapturedAt: null,
        });
      } catch (error) {
        if (isUndefinedTableError(error)) continue;
        throw error;
      }
      for (const state of stateRows) {
        if (
          toStringOrNull(state.provider_account_ref_id) !==
            account.providerAccountRefId ||
          toStringOrNull(state.provider_account_id) !==
            account.providerAccountId
        ) {
          continue;
        }
        addAdEntityState(statesByIdentity, input.businessId, state);
      }
    }

    const inputs = Array.from(mappedByIdentity.entries())
      .sort(
        ([, left], [, right]) =>
          left.input.providerAccountId.localeCompare(
            right.input.providerAccountId,
          ) || left.input.adId.localeCompare(right.input.adId),
      )
      .map(([key, item]) =>
        applyAdStatusEvidence({
          mapped: item,
          state: statesByIdentity.get(key),
          allowCurrentDimensionFallback,
        }),
      );
    const receipts = finalizeAdHydrationReceipts({
      sourceReceipts,
      inputs,
      businessId: input.businessId,
      asOf,
      decisionCutoff,
      adIdentityFilterApplied: adIds !== undefined,
    });
    return {
      inputs,
      receipts,
      accountCoverageComplete:
        receipts.length > 0 &&
        receipts.every((receipt) => receipt.authoritativeForPrune),
    };
  }

  async listAdDecisionInputs(
    input: AdDecisionInputQuery,
  ): Promise<AdDecisionInput[]> {
    return (await this.hydrateAdDecisionInputs(input)).inputs;
  }

  async getAdDecisionInput(input: {
    businessId: string;
    providerAccountId: string;
    adId: string;
    asOf: string;
    decisionCutoff: string;
  }): Promise<AdDecisionInput | null> {
    const providerAccountId = input.providerAccountId.trim();
    const adId = input.adId.trim();
    if (!providerAccountId || !adId) {
      throw new TypeError("providerAccountId and adId are required.");
    }
    const rows = await this.listAdDecisionInputs({
      businessId: input.businessId,
      asOf: input.asOf,
      decisionCutoff: input.decisionCutoff,
      providerAccountIds: [providerAccountId],
      adIds: [adId],
    });
    return rows[0] ?? null;
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
      "all",
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

  async getAccountCalibrationByKind(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountCalibration | null> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
      "account",
      "*",
      input.campaignKind,
    );
    return precomputed.calibration;
  }

  async getAccountCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>> {
    const byKind = emptyCalibrationByKind<AccountCalibration>();
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      byKind[campaignKind] = await this.getAccountCalibrationByKind({
        ...input,
        campaignKind,
      });
    }
    return byKind;
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
      "all",
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
    return (
      (await this.readAccountFunnelCalibration({
        ...input,
        campaignKind: "all",
      })) ?? zeroAccountFunnelCalibration("all")
    );
  }

  async getAccountFunnelCalibrationByKind(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountFunnelCalibration | null> {
    return this.readAccountFunnelCalibration(input);
  }

  async getAccountFunnelCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
  }): Promise<
    Record<CalibrationCampaignKind, AccountFunnelCalibration | null>
  > {
    const byKind = emptyCalibrationByKind<AccountFunnelCalibration>();
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      byKind[campaignKind] = await this.getAccountFunnelCalibrationByKind({
        ...input,
        campaignKind,
      });
    }
    return byKind;
  }

  private async readAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
  }): Promise<AccountFunnelCalibration | null> {
    let rows: FunnelCalibrationTableRow[];
    try {
      rows = await getDb().query<FunnelCalibrationTableRow>(
        READ_ACCOUNT_FUNNEL_CALIBRATION_QUERY,
        [input.businessId, input.asOf, input.campaignKind],
      );
    } catch {
      return null;
    }
    if (rows.length === 0) return null;

    const byFormat: Record<string, FormatFunnelBaseline> = {};
    for (const row of rows) {
      const baseline = mapFunnelCalibrationRow(row);
      if (baseline !== null) {
        byFormat[baseline.creativeFormat] = baseline;
      }
    }

    return { campaignKind: input.campaignKind, byFormat };
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
      const targetPack = await this.getBusinessTargetPack({
        businessId: input.businessId,
        asOf: input.asOf,
      });
      [row] = await getDb().query<CalibrationRow>(ACCOUNT_CALIBRATION_QUERY, [
        input.asOf,
        input.businessId,
        targetPack?.targetRoas ?? null,
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
    const sourceMaxUpdatedAt = toIsoTimestampOrNull(row?.source_max_updated_at);
    const sourceMaxDate = toIsoDateOrNull(row?.source_max_date);

    const calibration: AccountCalibration = {
      businessId: input.businessId,
      computedAt,
      campaignKind: "all",
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
    campaignKind: CalibrationCampaignKind,
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
        [businessId, asOf, scopeType, scopeId, campaignKind],
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

    const sourceMaxUpdatedAt = toIsoTimestampOrNull(row.source_max_updated_at);
    const computedAt = toIsoTimestampOrNull(row.computed_at);
    const asOfDate = toIsoDateOrNull(row.as_of_date) ?? asOf;
    const engineVersion = toStringOrNull(row.engine_version) ?? "unknown";
    const rowCampaignKind =
      toCalibrationCampaignKind(row.campaign_kind) ?? campaignKind;
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
        campaignKind: rowCampaignKind,
        matureCreativeCount: toIntegerOrNull(row.mature_creative_count) ?? 0,
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
    if (fromTable.length > 0 && input.creativeIds == null) return fromTable;
    if (fromTable.length > 0 && input.creativeIds != null) {
      const hydratedIds = new Set(
        fromTable.map((creative) => creative.creativeId),
      );
      const missingCreativeIds = input.creativeIds.filter(
        (creativeId) => !hydratedIds.has(creativeId),
      );
      if (missingCreativeIds.length === 0) return fromTable;

      const fallback = await this.computeCreativeInputsViaRuntimeSql({
        ...input,
        creativeIds: missingCreativeIds,
      });
      const byCreativeId = new Map(
        [...fromTable, ...fallback].map((creative) => [
          creative.creativeId,
          creative,
        ]),
      );
      return input.creativeIds.flatMap((creativeId) => {
        const creative = byCreativeId.get(creativeId);
        return creative ? [creative] : [];
      });
    }

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
      [input.businessId, input.creativeId, input.asOf, ENGINE_VERSION],
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
      "all",
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
        [businessId, asOf, ENGINE_VERSION],
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
    asOf?: string;
  }): Promise<BusinessTargetPack | null> {
    const referenceTime = resolveTargetReferenceTime(input.asOf);
    if (referenceTime === null) return null;
    let row: BusinessTargetPackRow | undefined;
    try {
      [row] = await getDb().query<BusinessTargetPackRow>(
        READ_BUSINESS_TARGET_PACK_QUERY,
        [input.businessId, referenceTime.toISOString()],
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
      updatedAt: toIsoTimestampOrNull(row.updated_at),
      freshness: resolveBusinessTargetPackFreshness(
        toIsoTimestampOrNull(row.updated_at),
        referenceTime,
      ),
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
      zeroConvBurnerMultiplier: toNumberOrNull(row.zero_conv_burner_multiplier),
      cutCandidateMultiplier: toNumberOrNull(row.cut_candidate_multiplier),
      sustainedLoserMultiplier: toNumberOrNull(row.sustained_loser_multiplier),
      hardCutMultiplier: toNumberOrNull(row.hard_cut_multiplier),
      scalePurchaseMultiplier: toNumberOrNull(row.scale_purchase_multiplier),
      winnerMemoryMultiplier: toNumberOrNull(row.winner_memory_multiplier),
      recentSampleMultiplier: toNumberOrNull(row.recent_sample_multiplier),
      weakFunnelRateMultiplier: toNumberOrNull(row.weak_funnel_rate_multiplier),
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
