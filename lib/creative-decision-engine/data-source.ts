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
  type AdDisjointBandEvidence,
  type AdDisjointBandObservation,
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

  /**
   * Return per-account self-calibrated values (Tier 3).
   *
   * ACCOUNT SCOPE IS OPT-IN, AND ITS ABSENCE MEANS THE BUSINESS.
   *
   * A business can hold several Meta ad accounts, and "the account" in this
   * method's name has historically meant the business's whole Meta footprint:
   * both the precomputed row (`scope_type 'account'`, `scope_id '*'`) and the
   * runtime SQL aggregate every account the business owns. That is the right
   * answer for a business-wide surface and the wrong one for anything that
   * speaks for a SINGLE ad account — one account's samples then set another
   * account's percentiles, and an account with no evidence of its own is
   * handed a sibling's.
   *
   * So `providerAccountId` narrows the MEASUREMENT to one physical account:
   * the precomputed read looks for that account's own scope and the runtime
   * fallback filters `meta_creative_daily` to it. Callers that omit it keep
   * the business-wide reading they always had, byte for byte.
   */
  getAccountCalibration(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountCalibration>;

  /** Return one kind-segmented account calibration row. P1b data-only. */
  getAccountCalibrationByKind?(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
    providerAccountId?: string | null;
  }): Promise<AccountCalibration | null>;

  /** Return all available kind-segmented account calibration rows. P1b data-only. */
  getAccountCalibrationAllKinds?(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<Record<CalibrationCampaignKind, AccountCalibration | null>>;

  /** Return campaign-scoped calibration, plus sample size when the row is unavailable. */
  getCampaignCalibration(input: {
    businessId: string;
    asOf: string;
    campaignId: string;
  }): Promise<CampaignCalibrationLookup>;

  /**
   * Return per-format account funnel baselines (Phase 3.9).
   *
   * `providerAccountId` narrows the read to one ad account's own retained
   * baselines, on the same terms as {@link getAccountCalibration}. Omitting it
   * keeps the business-wide `scope_id '*'` read.
   */
  getAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountFunnelCalibration>;

  /** Return one kind-segmented funnel calibration pack. P1b data-only. */
  getAccountFunnelCalibrationByKind?(input: {
    businessId: string;
    asOf: string;
    campaignKind: CalibrationCampaignKind;
    providerAccountId?: string | null;
  }): Promise<AccountFunnelCalibration | null>;

  /** Return all available kind-segmented funnel calibration packs. P1b data-only. */
  getAccountFunnelCalibrationAllKinds?(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
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

  /**
   * Cutoff-safe Meta-attributed AOV authority for one physical ad account.
   *
   * A blank `providerAccountId` cannot establish account-local authority and
   * therefore returns an empty sample. Under Target ROAS this read owns the
   * profile value even when a legacy calibration row already contains AOV.
   */
  getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
    providerAccountId?: string | null;
  }): Promise<MetaAttributedAovResult>;

  /**
   * Whether one account's OWN calibration scope has been materialised, and if
   * not, whether ANY account of the business has one.
   *
   * WHY A CALLER HAS TO BE ABLE TO ASK. A scoped calibration read answers a
   * miss the way it answers an empty account: `getAccountFunnelCalibration`
   * returns a pack with no formats in it and `getAccountCalibrationByKind`
   * returns null. Those are measurements — "this account ran nothing that the
   * baselines could be computed from" — and they are indistinguishable from
   * "the job has never written this account's scope, so nobody has measured
   * anything". A caller that stamps an identity on the measured facts has to
   * know which of the two it is holding, because in the second case the numbers
   * it does get come from the runtime fallback and are recomputed on every
   * read.
   *
   * AND WHY THE SECOND FACT TRAVELS WITH IT. A miss has two very different
   * causes and only one of them is about this account. If sibling accounts of
   * the same business DO have their own scopes, the pass covered them and not
   * this one, which is a fact about this account. If NO account of the business
   * has one, the per-account dimension does not exist in this warehouse yet —
   * the pass has never written it for anybody — and refusing this account says
   * nothing about this account. The two are distinguished here rather than by
   * each caller guessing, and {@link AccountScopeCalibrationMaterialisation}
   * names them apart.
   *
   * Optional because a data source that does not model the precomputed table at
   * all — a double that simply answers with calibrations — has no such fact to
   * report. Every production path runs against {@link WarehouseDataSource},
   * which implements it.
   */
  readAccountScopeCalibrationMaterialisation?(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountScopeCalibrationMaterialisation>;

  /**
   * Whether this business's warehouse rows belong to this ad account ALONE.
   *
   * WHAT IT IS FOR. The pooled `scope_id '*'` calibration row is computed over
   * every `meta_creative_daily` row the business owns. When the business owns
   * rows for exactly ONE ad account, that pooled row is not an approximation of
   * the account's own measurement — it IS the account's own measurement,
   * computed by the same statement over the same rows. A caller that needs one
   * account's population may then read the stable precomputed pooled row
   * instead of recomputing a runtime aggregate, and it is not borrowing
   * anything from anybody.
   *
   * THE PROOF IS FROM THE DATA, NOT FROM THE ASSIGNMENT TABLE. A business can
   * hold warehouse rows for an account it no longer selects, and
   * `business_provider_accounts` would not show it. The question asked here is
   * whether any `meta_creative_daily` row of this business names a DIFFERENT
   * provider account, which is the only thing that can make the pooled
   * population wider than this account's.
   *
   * `unreadable` is a failed read and is never reported as either answer: the
   * caller falls back to scoping the reads to the account itself, which is
   * always correct and never borrows.
   *
   * Optional because a data source that models no warehouse has no such fact.
   */
  readBusinessAccountPopulationBreadth?(input: {
    businessId: string;
    providerAccountId: string;
  }): Promise<BusinessAccountPopulationBreadth>;
}

/**
 * Whether a business's warehouse rows come from one ad account or several.
 *
 * - `sole_account` — every row belongs to the named account, so the business's
 *   pooled population and that account's population are the same rows.
 * - `multiple_accounts` — at least one row belongs to a different account, so
 *   the pooled population is wider than the named account's and a pooled read
 *   would carry evidence this account did not produce.
 * - `unreadable` — the question could not be answered, either because the probe
 *   failed or because no account was named for the population to be compared
 *   against. Nothing is established, and it is never treated as `sole_account`.
 */
export type BusinessAccountPopulationBreadth =
  | "sole_account"
  | "multiple_accounts"
  | "unreadable";

/**
 * The four states of one account's own precomputed calibration scope.
 *
 * - `materialised` — this account has a scope row of its own, so a scoped read
 *   is served from a row that is fixed for the day it speaks for.
 * - `absent` — this account has none and at least one SIBLING account of the
 *   same business does. The pass covered the business and skipped this account:
 *   a fact about this account, and the only state in which a per-account
 *   refusal tells the operator something true about it.
 * - `per_account_scopes_unwritten` — no account of this business has a scope of
 *   its own, for any account. The per-account dimension has never been written
 *   here; `lib/creative-decision-engine/jobs/calibration-job.ts` gained the
 *   writer in 058a1c8f6 and a warehouse the pass has not run against since then
 *   holds only the pooled `scope_id '*'` rows the previous release wrote. This
 *   is a fact about the WAREHOUSE, not about the account, and it resolves
 *   permanently on the next successful calibration run.
 * - `unreadable` — the probe itself failed, so there is no fact at all.
 *
 * `absent`, `per_account_scopes_unwritten` and `unreadable` are kept apart on
 * purpose, and none of them may be reported as `materialised`. A caller that
 * fails closed may treat several of them the same way — but it can always say
 * which one it saw, and it can say so differently.
 */
export type AccountScopeCalibrationMaterialisation =
  | "materialised"
  | "absent"
  | "per_account_scopes_unwritten"
  | "unreadable";

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
  /**
   * The source run's ORIGINAL captured_at. Heartbeat coalescing advances
   * sourceCapturedAt (freshness) but never this payload clock; the hydration
   * capture floor must use this value so a coalesced run can still read its
   * own state rows.
   */
  sourcePayloadCapturedAt: string | null;
  /**
   * D075 manifest storage kind of the source run. `null` = legacy full
   * manifest. Purely provenance/telemetry: the completeness bar
   * (persisted == expected) is already manifest-aware inside the receipt
   * query's member reconstruction.
   */
  sourceManifestKind: "full" | "delta" | null;
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
  band_cutoff_date: unknown;
  recent14_start_date: unknown;
  recent14_end_date: unknown;
  recent14_row_count: unknown;
  recent14_spend: unknown;
  recent14_conversions: unknown;
  recent14_revenue: unknown;
  recent14_impressions: unknown;
  recent14_clicks: unknown;
  recent14_link_clicks: unknown;
  recent14_link_clicks_measured_rows?: unknown;
  recent14_link_clicks_missing_delivered_rows?: unknown;
  prior14_start_date: unknown;
  prior14_end_date: unknown;
  prior14_row_count: unknown;
  prior14_spend: unknown;
  prior14_conversions: unknown;
  prior14_revenue: unknown;
  prior14_impressions: unknown;
  prior14_clicks: unknown;
  prior14_link_clicks: unknown;
  prior14_link_clicks_measured_rows?: unknown;
  prior14_link_clicks_missing_delivered_rows?: unknown;
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
  presence: unknown;
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
  source_payload_captured_at: unknown;
  source_manifest_kind: unknown;
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

/**
 * The rows a missing link-click reading counts AGAINST.
 *
 * A day with no delivery legitimately has no link clicks, so a NULL there is
 * not a gap. The delivery test used to be impressions or spend alone, which
 * silently exempted every OTHER kind of decision-bearing day: a row that
 * recorded clicks, conversions or revenue while its spend and impressions came
 * back zero — a late-attributed conversion, a lifetime-budget day whose spend
 * lands on the parent, a partial capture — was treated as "did not deliver",
 * so its NULL link-click reading did not count as missing and the band was
 * admitted as fully measured. The composite then divided by a link-click total
 * that was missing exactly the days that carried the outcome.
 *
 * Named and shared so the completeness test and any future reader of "did this
 * ad-day do anything" cannot drift apart. A genuinely inert day — every one of
 * these zero or NULL — is still not a gap, which is the semantics this keeps.
 */
export const AD_DAY_DECISION_BEARING_ACTIVITY_SQL = `(
      COALESCE(impressions, 0) > 0
      OR COALESCE(spend, 0) > 0
      OR COALESCE(clicks, 0) > 0
      OR COALESCE(conversions, 0) > 0
      OR COALESCE(revenue, 0) > 0
    )`;

/**
 * The ad-day link-click value that has enough row-local provenance to enter a
 * lifecycle band.
 *
 * `meta_ad_daily.link_clicks` used to be `NOT NULL DEFAULT 0`, and the old
 * writer supplied a literal zero when Meta supplied no actions breakdown. The
 * nullable migration deliberately preserved those historical zeros, so the
 * column alone cannot prove that a stored zero was measured. The verbatim
 * provider payload can: an `actions` array with no `link_click` entry is Meta's
 * measured-zero encoding, while one exact zero entry is also accepted by the
 * strict forward parser. A missing, malformed, duplicate, or contradictory
 * entry leaves the zero unknown. Positive stored values are not affected by
 * the legacy default/fabrication and remain measurements.
 *
 * Kept as one shared SQL expression because the decision hydration query and
 * the operational readback verifier must classify the same row identically.
 */
export const AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL = `(CASE
      WHEN link_clicks > 0 THEN link_clicks
      WHEN link_clicks = 0
        AND jsonb_typeof(payload_json->'actions') = 'array'
        AND (
          SELECT CASE
            WHEN COUNT(*) = 0 THEN TRUE
            WHEN COUNT(*) = 1
              THEN COALESCE(
                BOOL_AND(
                  jsonb_typeof(action->'value') = 'string'
                  AND COALESCE(action->>'value', '') ~ '^0+$'
                ),
                FALSE
              )
            ELSE FALSE
          END
          FROM jsonb_array_elements(
            CASE
              WHEN jsonb_typeof(payload_json->'actions') = 'array'
                THEN payload_json->'actions'
              ELSE '[]'::jsonb
            END
          ) AS action
          WHERE action->>'action_type' = 'link_click'
        )
      THEN 0
      ELSE NULL
    END)`;

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
    -- NULL-SAFETY ONLY. NOT a decision change. meta_ad_daily.link_clicks can
    -- now be NULL (the provider supplied nothing) instead of a fabricated 0.
    -- PostgreSQL SUM IGNORES nulls, so a window in which every row is
    -- unsupplied would return NULL where it returns 0 today.
    --
    -- The coalesce is INSIDE the SUM on purpose. COALESCE(SUM(x), 0) would also
    -- turn "no rows matched this window at all" from NULL into 0, which is a
    -- different answer than today's. SUM(COALESCE(x, 0)) is NULL over zero rows
    -- and 0 over all-unsupplied rows -- exactly what the NOT NULL column
    -- returns today, for every window. The engine saw 0 and still sees 0.
    SUM(COALESCE(link_clicks, 0)) AS link_clicks,
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
/*
  The equal, disjoint, directly adjacent 14/14 ad-day pair the ad-level
  fatigue contract requires.

  Mirrors the creative-grain 'last14'/'prior14' shape in
  HYDRATE_CREATIVE_INPUTS_QUERY's historical_source CTE, at ad grain and with
  the two extra denominators the composite needs (clicks and link_clicks).
  Each band is its OWN SUM over meta_ad_daily; nothing is reconstructed by
  subtracting one window from another, which is what DECISION_LOG.md D037
  forbids.

  PIT safety comes from selected_ad_days, which is already bounded to
  ($2::date - 27 days) .. $2::date, truth_state finalized, validation_status
  passed, and created_at/updated_at <= the decision cutoff. recent14 ends on
  $2::date and prior14 ends 14 days earlier, so no row dated after the cutoff
  can enter either band.
*/
ad_band_days AS (
  SELECT
    d.provider_account_id,
    d.ad_id,
    bands.band_key,
    d.spend,
    d.conversions,
    d.revenue,
    d.impressions,
    d.clicks,
    ${AD_DAY_AUTHORITATIVE_LINK_CLICKS_SQL} AS link_clicks
  FROM selected_ad_days d
  CROSS JOIN LATERAL (
    VALUES
      ('recent14', d.date BETWEEN ($2::date - INTERVAL '13 days') AND $2::date),
      ('prior14', d.date BETWEEN ($2::date - INTERVAL '27 days') AND ($2::date - INTERVAL '14 days'))
  ) AS bands(band_key, in_band)
  WHERE bands.in_band
),
ad_band_aggregates AS (
  SELECT
    provider_account_id,
    ad_id,
    band_key,
    COUNT(*)::integer AS band_row_count,
    SUM(spend) AS spend,
    SUM(conversions) AS conversions,
    SUM(revenue) AS revenue,
    SUM(impressions) AS impressions,
    SUM(clicks) AS clicks,
    -- DELIBERATELY NOT COALESCED, unlike metric_cumulative above.
    --
    -- ad_band_days.link_clicks has already excluded every legacy stored zero
    -- that lacks matching row-local payload provenance. PostgreSQL SUM ignores
    -- those NULLs and returns NULL only when every row in the group is unknown,
    -- so this expression preserves measured positive/zero versus unknown.
    -- metric_cumulative intentionally keeps its compatibility coalesce; only
    -- these new decision-authority bands apply the stronger provenance rule.
    SUM(link_clicks) AS link_clicks,
    -- COMPLETENESS, because SUM alone cannot express it.
    --
    -- SUM ignores NULLs and returns NULL only when EVERY row in the group is
    -- NULL. A band with three measured days and eleven delivered days the
    -- provider never reported therefore returns a positive number that looks
    -- exactly like complete coverage, and the composite divided by it as
    -- though it were. That is partial evidence presented as measured.
    --
    -- A day with no delivery legitimately has no link clicks, so the missing
    -- count is taken only over rows that actually did something. The test is
    -- AD_DAY_DECISION_BEARING_ACTIVITY_SQL: impressions OR spend OR clicks OR
    -- conversions OR revenue. It used to be impressions or spend alone, which
    -- exempted a row that recorded clicks, conversions or revenue on a day
    -- whose spend and impressions came back zero -- precisely the anomalous
    -- rows a partial band is most likely to contain. A wholly inert day is
    -- still not a gap.
    COUNT(*) FILTER (WHERE link_clicks IS NOT NULL)::integer
      AS link_clicks_measured_rows,
    COUNT(*) FILTER (
      WHERE link_clicks IS NULL
        AND ${AD_DAY_DECISION_BEARING_ACTIVITY_SQL}
    )::integer AS link_clicks_missing_delivered_rows
  FROM ad_band_days
  GROUP BY provider_account_id, ad_id, band_key
),
ad_bands AS (
  SELECT
    provider_account_id,
    ad_id,
    MAX(band_row_count) FILTER (WHERE band_key = 'recent14') AS recent14_row_count,
    MAX(spend) FILTER (WHERE band_key = 'recent14') AS recent14_spend,
    MAX(conversions) FILTER (WHERE band_key = 'recent14') AS recent14_conversions,
    MAX(revenue) FILTER (WHERE band_key = 'recent14') AS recent14_revenue,
    MAX(impressions) FILTER (WHERE band_key = 'recent14') AS recent14_impressions,
    MAX(clicks) FILTER (WHERE band_key = 'recent14') AS recent14_clicks,
    MAX(link_clicks) FILTER (WHERE band_key = 'recent14') AS recent14_link_clicks,
    MAX(link_clicks_measured_rows) FILTER (WHERE band_key = 'recent14')
      AS recent14_link_clicks_measured_rows,
    MAX(link_clicks_missing_delivered_rows) FILTER (WHERE band_key = 'recent14')
      AS recent14_link_clicks_missing_delivered_rows,
    MAX(band_row_count) FILTER (WHERE band_key = 'prior14') AS prior14_row_count,
    MAX(spend) FILTER (WHERE band_key = 'prior14') AS prior14_spend,
    MAX(conversions) FILTER (WHERE band_key = 'prior14') AS prior14_conversions,
    MAX(revenue) FILTER (WHERE band_key = 'prior14') AS prior14_revenue,
    MAX(impressions) FILTER (WHERE band_key = 'prior14') AS prior14_impressions,
    MAX(clicks) FILTER (WHERE band_key = 'prior14') AS prior14_clicks,
    MAX(link_clicks) FILTER (WHERE band_key = 'prior14') AS prior14_link_clicks,
    MAX(link_clicks_measured_rows) FILTER (WHERE band_key = 'prior14')
      AS prior14_link_clicks_measured_rows,
    MAX(link_clicks_missing_delivered_rows) FILTER (WHERE band_key = 'prior14')
      AS prior14_link_clicks_missing_delivered_rows
  FROM ad_band_aggregates
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
  /*
    The band window boundaries are emitted by SQL, not re-derived in
    TypeScript, so the dates a consumer reads always describe exactly the rows
    that were summed above. A second arithmetic in the mapper could drift from
    this one and label a 13-day sum as a 14-day band.
  */
  $2::date::text AS band_cutoff_date,
  ($2::date - INTERVAL '13 days')::date::text AS recent14_start_date,
  $2::date::text AS recent14_end_date,
  ($2::date - INTERVAL '27 days')::date::text AS prior14_start_date,
  ($2::date - INTERVAL '14 days')::date::text AS prior14_end_date,
  ad_bands.recent14_row_count,
  ad_bands.recent14_spend,
  ad_bands.recent14_conversions,
  ad_bands.recent14_revenue,
  ad_bands.recent14_impressions,
  ad_bands.recent14_clicks,
  ad_bands.recent14_link_clicks,
  ad_bands.recent14_link_clicks_measured_rows,
  ad_bands.recent14_link_clicks_missing_delivered_rows,
  ad_bands.prior14_row_count,
  ad_bands.prior14_spend,
  ad_bands.prior14_conversions,
  ad_bands.prior14_revenue,
  ad_bands.prior14_impressions,
  ad_bands.prior14_clicks,
  ad_bands.prior14_link_clicks,
  ad_bands.prior14_link_clicks_measured_rows,
  ad_bands.prior14_link_clicks_missing_delivered_rows,
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
LEFT JOIN ad_bands
  ON ad_bands.provider_account_id = cumulative.provider_account_id
 AND ad_bands.ad_id = cumulative.ad_id
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
    NULL::text AS tombstone_reason,
    -- D075: absent_unconfirmed scope-exit rows compete for latest so they
    -- shadow the stale present row; consumers treat a non-present winner as
    -- absence evidence, never as usable state.
    state.presence
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
    tombstone.reason AS tombstone_reason,
    NULL::text AS presence
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
  tombstone_reason,
  presence
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
    state.created_at,
    state.presence
  FROM meta_entity_state_history state
  WHERE state.business_ref_id = $1::uuid
    AND state.business_id = $1::text
    AND state.entity_type = 'ad'
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
    tombstone.created_at,
    NULL::text AS presence
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
-- D075: a scope-exit winner (absent_unconfirmed) is current truth that the
-- ad left the observed scope; it must not seed and must not let the older
-- present row seed either.
WHERE event_kind = 'state' AND presence = 'present'
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
    -- Freshness clocks: heartbeat-advanced when a byte-identical re-observation
    -- coalesced. LEAST() clamps transitional rows whose last_seen_at advanced
    -- under pre-last_captured_at code, so the pair can never invert
    -- (observed newer than captured).
    LEAST(
      COALESCE(run.last_seen_at, run.observed_at),
      COALESCE(run.last_captured_at, run.captured_at)
    ) AS source_observed_at,
    COALESCE(run.last_captured_at, run.captured_at) AS source_captured_at,
    -- Payload clock: the ORIGINAL capture time of the run whose state rows
    -- form the manifest. Heartbeats advance the freshness clocks above but
    -- never this one; hydration's capture floor must use this value or every
    -- coalesced run filters out its own payload.
    run.captured_at AS source_payload_captured_at,
    run.manifest_kind AS source_manifest_kind,
    run.endpoint AS source_endpoint,
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
      AND COALESCE(run.last_seen_at, run.observed_at) >= $2::date
      AND COALESCE(run.last_seen_at, run.observed_at) <= $3::timestamptz
      AND COALESCE(run.last_captured_at, run.captured_at) <= $3::timestamptz
      -- Compaction may retain a duplicate run receipt while removing its
      -- redundant state rows. Skip only fully removed positive-row runs;
      -- base_counts still exposes partially retained sets as a mismatch.
      AND (
        run.row_count = 0
        -- A delta run's manifest lives in the reconstructed complete lane;
        -- a zero-change forced checkpoint owns no state rows at all, and
        -- that is not compaction.
        OR run.manifest_kind = 'delta'
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
    ORDER BY COALESCE(run.last_seen_at, run.observed_at) DESC,
             COALESCE(run.last_captured_at, run.captured_at) DESC,
             run.created_at DESC, run.id DESC
    LIMIT 1
  ) run ON true
), member_states AS (
  -- Effective manifest membership per selected run (D075).
  --
  -- Legacy/full runs: the manifest is the run's exact immutable payload —
  -- membership stays bound to the original run id, so a later partial run
  -- cannot silently reshape the expected identity set.
  --
  -- Delta runs: the manifest is the reconstructed complete lane — the latest
  -- complete-lane row per entity at or before the run's PAYLOAD capture
  -- clock, keeping entities whose winning row is present. An absent
  -- (scope-exit) winner drops its entity here, so a stale present row can
  -- never be resurrected past an explicit exit. Partial and point-lookup
  -- rows never enter delta reconstruction.
  SELECT
    run.provider_account_id,
    run.source_run_id,
    member.id,
    member.entity_id,
    member.observed_at,
    member.captured_at,
    member.created_at
  FROM complete_runs run
  JOIN LATERAL (
    SELECT state.id, state.entity_id, state.observed_at, state.captured_at,
           state.created_at
    FROM meta_entity_state_history state
    WHERE run.source_run_id IS NOT NULL
      AND run.source_manifest_kind IS DISTINCT FROM 'delta'
      AND state.run_id = run.source_run_id
      AND state.business_ref_id = run.business_ref_id
      AND state.business_id = run.business_id
      AND state.provider_account_ref_id = run.provider_account_ref_id
      AND state.provider_account_id = run.provider_account_id
      AND state.entity_type = 'ad'
      AND state.presence = 'present'
      AND state.run_completeness IN ('complete', 'partial', 'point_lookup')
      AND state.observed_at <= $3::timestamptz
      AND state.captured_at <= $3::timestamptz

    UNION ALL

    SELECT latest.id, latest.entity_id, latest.observed_at,
           latest.captured_at, latest.created_at
    FROM (
      SELECT DISTINCT ON (state.entity_id)
        state.id, state.entity_id, state.observed_at, state.captured_at,
        state.created_at, state.presence
      FROM meta_entity_state_history state
      WHERE run.source_run_id IS NOT NULL
        AND run.source_manifest_kind = 'delta'
        AND state.business_ref_id = run.business_ref_id
        AND state.business_id = run.business_id
        AND state.provider_account_ref_id = run.provider_account_ref_id
        AND state.provider_account_id = run.provider_account_id
        AND state.entity_type = 'ad'
        AND state.run_completeness = 'complete'
        -- The reconstruction scope is the source run's ENDPOINT — the same
        -- scope unit the writer diffs against. Rows observed by a different
        -- endpoint are a different manifest and must not leak in.
        AND EXISTS (
          SELECT 1
          FROM meta_entity_observation_runs scope_run
          WHERE scope_run.id = state.run_id
            AND scope_run.endpoint = run.source_endpoint
        )
        AND state.captured_at <= run.source_payload_captured_at
        AND state.observed_at <= $3::timestamptz
        AND state.captured_at <= $3::timestamptz
      ORDER BY state.entity_id, state.captured_at DESC, state.created_at DESC,
        state.id DESC
    ) latest
    WHERE latest.presence = 'present'
  ) member ON true
), base_counts AS (
  SELECT
    member.source_run_id,
    COUNT(member.id)::integer AS source_persisted_row_count
  FROM member_states member
  GROUP BY member.source_run_id
), truth_events AS (
  SELECT
    member.provider_account_id,
    'state'::text AS event_kind,
    member.id,
    member.entity_id,
    member.observed_at,
    member.captured_at,
    member.created_at
  FROM member_states member

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
    -- Tombstones are written under their own point_lookup runs, never under
    -- the complete observation run, so binding this arm to source_run_id
    -- would make it unmatchable and freeze deleted ads into the manifest
    -- forever. Membership is identity-scoped and floored by the run's
    -- EFFECTIVE capture clock: a tombstone captured after the latest full
    -- (re-)observation shrinks the manifest, while a tombstone the complete
    -- run itself supersedes (the ad was re-observed present afterwards) does
    -- not censor the reappeared ad. State observed_at can be the provider's
    -- old updated_time, so the capture floor — not observed ordering alone —
    -- is what keeps this comparison honest.
    ON run.source_run_id IS NOT NULL
   AND tombstone.captured_at >= run.source_captured_at
   AND tombstone.business_ref_id = run.business_ref_id
   AND tombstone.business_id = run.business_id
   AND tombstone.provider_account_ref_id = run.provider_account_ref_id
   AND tombstone.provider_account_id = run.provider_account_id
   AND tombstone.entity_type = 'ad'
   AND tombstone.reason IN ('explicit_deleted', 'explicit_not_found')
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
  run.source_payload_captured_at::text AS source_payload_captured_at,
  run.source_manifest_kind,
  run.source_run_hash,
  run.source_payload_hash,
  run.source_expected_row_count,
  CASE
    WHEN run.source_run_id IS NULL THEN NULL
    ELSE COALESCE(counts.source_persisted_row_count, 0)
  END AS source_persisted_row_count,
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
  run.source_payload_captured_at,
  run.source_manifest_kind,
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
    -- NULL-SAFETY ONLY. NOT a decision change. Same law as the ad-grain
    -- aggregate above, on meta_creative_daily -- the table the DEFAULT Assets
    -- grain reads. Coalesce inside the SUM so an all-unsupplied window still
    -- yields 0 and an empty window still yields NULL, exactly as today. The
    -- engine saw 0 for these rows before and sees 0 for them now.
    SUM(COALESCE(d.link_clicks, 0)) AS link_clicks,
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
    -- NULL-SAFETY ONLY. NOT a decision change. Coalesced here, where the raw
    -- column leaves the table, so the click_to_purchase_rate aggregate below
    -- stays textually and numerically identical: SUM(link_clicks) > 0 and
    -- SUM(conversions) / NULLIF(SUM(link_clicks), 0) now see the same 0 they
    -- see today for an unsupplied row rather than a NULL that would collapse
    -- the whole window's SUM. The engine saw 0 and still sees 0.
    COALESCE(d.link_clicks, 0) AS link_clicks
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

/*
  `$4` is the OPTIONAL provider account this calibration speaks for.

  NULL keeps the business-wide population every existing caller has always
  aggregated. A value restricts every population in this statement — the
  percentiles, the counts, the Meta-attributed AOV and the source bounds — to
  that one ad account, because a percentile computed over two accounts is not a
  calibration of either of them.
*/
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
    AND ($4::text IS NULL OR provider_account_id = $4::text)
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
    AND ($4::text IS NULL OR provider_account_id = $4::text)
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
    AND ($4::text IS NULL OR provider_account_id = $4::text)
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

/**
 * The `scope_id` the business's whole Meta footprint is written under.
 *
 * Every OTHER account-scope row names one physical ad account, so `scope_id <>`
 * this value is exactly "some account's own scope". The statement below spells
 * the same literal because a parameter there would defeat the index's leading
 * columns for no gain.
 */
const ACCOUNT_CALIBRATION_POOLED_SCOPE_ID = "*";

/*
  Existence, not freshness, and not one particular day's read — and TWO such
  facts in one round trip: this account's own scope, and whether ANY
  account-named scope exists for this business at all.

  This asks only whether the calibration job has ever written these scopes for a
  day this read could reach. It deliberately does not apply the staleness rule
  `READ_ACCOUNT_CALIBRATION_QUERY`'s caller applies: a stale row is a row that
  WAS materialised, and the caller's question is whether anyone has ever
  measured this account, not whether today's reading is fresh enough to use.

  The second fact is what separates "the pass skipped this account" from "the
  pass has never written per-account scopes for anybody here".

  WHAT EACH HALF COSTS. Both are bounded to ONE business's
  `scope_type = 'account'` rows, which is the leading prefix of
  `idx_engine_v3_calibration_latest`
  (`business_ref_id, scope_type, scope_id, as_of_date DESC`). The first adds an
  equality on `scope_id` and reaches one entry. The second cannot narrow by
  `scope_id` — `<>` is not a range predicate, and deliberately so, because a
  range would depend on where the database's collation sorts `'*'` — so it stops
  at the first non-pooled scope id inside that prefix. Its worst case is a
  business that has ONLY pooled rows, which is exactly the transitional state:
  that business's own account-scope rows, and nothing belonging to any other
  business.
*/
const READ_ACCOUNT_SCOPE_MATERIALISATION_QUERY = `
SELECT
  EXISTS (
    SELECT 1
    FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = $1::uuid
      AND scope_type = 'account'
      AND scope_id = $3::text
      AND as_of_date <= $2::date
  ) AS own_scope_present,
  EXISTS (
    SELECT 1
    FROM engine_v3_account_calibration_daily
    WHERE business_ref_id = $1::uuid
      AND scope_type = 'account'
      AND scope_id <> '*'
      AND as_of_date <= $2::date
  ) AS any_account_scope_present
`;

/*
  Does ANY warehouse row of this business belong to some OTHER ad account?

  TWO RANGES RATHER THAN ONE `<>`, and that is a performance fact rather than a
  semantic one. `provider_account_id <> $2` under `business_id = $1` cannot seek
  in `idx_meta_creative_daily_business_account_date`
  (`business_id, provider_account_id, date DESC`): a btree has no skip scan, so
  it would walk every index entry the named account owns before concluding that
  none differs — which on a busy account is the whole account. `< $2` and `> $2`
  are each a seekable range that stops at its first tuple, and they ask the same
  question: `<`, `=` and `>` are exhaustive and mutually exclusive over the
  index's own ordering, so `v <> $2` and `v < $2 OR v > $2` select the same rows.

  `business_id` (TEXT) rather than `business_ref_id` (UUID) on purpose, for two
  reasons. It is the indexed column, and it is the WIDER set: `business_ref_id`
  is filled from a reference lookup that can leave NULL, and the calibration
  statements filter on it. A business whose wider set names no other account
  therefore certainly has no other account inside the narrower set the pooled
  calibration row was computed from, so this probe can only ever be too strict —
  it can withhold the equivalence, never assert one that is false.
*/
const READ_BUSINESS_ACCOUNT_POPULATION_BREADTH_QUERY = `
SELECT
  (
    EXISTS (
      SELECT 1
      FROM meta_creative_daily
      WHERE business_id = $1::text
        AND provider_account_id < $2::text
    )
    OR EXISTS (
      SELECT 1
      FROM meta_creative_daily
      WHERE business_id = $1::text
        AND provider_account_id > $2::text
    )
  ) AS foreign_account_rows_present
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

/*
  `$4` is the account scope this pack speaks for: `'*'` for the business's whole
  Meta footprint, or one provider account id. It was a literal `'*'` before, so
  a per-account caller was silently served the business-wide baselines.
*/
const READ_ACCOUNT_FUNNEL_CALIBRATION_QUERY = `
WITH latest_day AS (
  SELECT MAX(as_of_date) AS as_of_date
  FROM engine_v3_account_calibration_daily
  WHERE business_ref_id = $1::uuid
    AND scope_type = 'account'
    AND scope_id = $4::text
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
  AND scope_id = $4::text
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
  const sourcePayloadCapturedAt = toIsoTimestampOrNull(
    input.row.source_payload_captured_at,
  );
  const manifestKindRaw = toStringOrNull(input.row.source_manifest_kind);
  const sourceManifestKind =
    manifestKindRaw === "full" || manifestKindRaw === "delta"
      ? manifestKindRaw
      : null;
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
    sourcePayloadCapturedAt,
    sourceManifestKind,
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
        sourcePayloadCapturedAt: null,
        sourceManifestKind: null,
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

/**
 * One hydrated 14-day band, exactly as the `ad_bands` CTE returned it.
 *
 * Every numeric field stays three-valued. `null` means the warehouse reported
 * nothing for that field across the whole window, which is not the same claim
 * as a measured zero, and `admitCompositeBand` in
 * `lib/creative-decision-engine/jobs/ad-decisions-job.ts` names each absence
 * rather than coercing it. `meta_ad_daily.link_clicks` is the live case:
 * `NULL` for a day the provider supplied nothing and a number for a measured
 * day, including a measured `0`.
 */
function toAdDisjointBandObservation(input: {
  startDate: unknown;
  endDate: unknown;
  spend: unknown;
  conversions: unknown;
  revenue: unknown;
  impressions: unknown;
  clicks: unknown;
  linkClicks: unknown;
  linkClicksMissingDeliveredRows: unknown;
}): AdDisjointBandObservation | null {
  const startDate = toIsoDateOrNull(input.startDate);
  const endDate = toIsoDateOrNull(input.endDate);
  if (startDate === null || endDate === null) return null;
  /*
    PARTIAL LINK-CLICK COVERAGE IS UNKNOWN, NOT MEASURED.

    `SUM(link_clicks)` returns NULL only when every row in the band is NULL, so
    a band with three measured days and eleven delivered days the provider
    never reported came back as a positive number indistinguishable from
    complete coverage — and the click-to-purchase composite divided by it. That
    is a denominator built from part of a window, presented as the whole of it,
    and it can authorize a Refresh.

    The query counts the delivered rows whose link clicks are missing. Any such
    row makes the band's link-click total UNKNOWN. A measured 0 across a fully
    reported band is untouched and stays 0: absence and a measured zero remain
    different answers, which is the distinction the raw column exists to keep.
  */
  const missingDelivered = toNumberOrNull(input.linkClicksMissingDeliveredRows);
  const linkClicksComplete = missingDelivered !== null && missingDelivered === 0;
  return {
    startDate,
    endDate,
    spend: toNumberOrNull(input.spend),
    purchases: toNumberOrNull(input.conversions),
    revenue: toNumberOrNull(input.revenue),
    impressions: toNumberOrNull(input.impressions),
    clicks: toNumberOrNull(input.clicks),
    linkClicks: linkClicksComplete ? toNumberOrNull(input.linkClicks) : null,
  };
}

/**
 * The equal, disjoint, directly adjacent 14/14 pair for one ad.
 *
 * Returns null only when the query produced no band window at all — an ad with
 * no finalized, validated ad-day rows inside the cutoff-bound 28-day window.
 * That ad also carries `performanceMetricsObserved: false`, so the contract
 * withholds its verdict for the metric reason before it ever looks at bands.
 *
 * A band whose window exists but which the ad did not deliver into comes back
 * with null sums rather than zeros: `SUM` over zero rows is NULL in
 * PostgreSQL, and the contract reads that as "no admissible delivery in this
 * window", never as "delivered nothing".
 */
function toAdBandEvidence(
  row: AdDecisionHydrationRow,
): AdDisjointBandEvidence | null {
  const cutoffDate = toIsoDateOrNull(row.band_cutoff_date);
  if (cutoffDate === null) return null;
  const recent14 = toAdDisjointBandObservation({
    startDate: row.recent14_start_date,
    endDate: row.recent14_end_date,
    spend: row.recent14_spend,
    conversions: row.recent14_conversions,
    revenue: row.recent14_revenue,
    impressions: row.recent14_impressions,
    clicks: row.recent14_clicks,
    linkClicks: row.recent14_link_clicks,
    linkClicksMissingDeliveredRows:
      row.recent14_link_clicks_missing_delivered_rows,
  });
  const prior14 = toAdDisjointBandObservation({
    startDate: row.prior14_start_date,
    endDate: row.prior14_end_date,
    spend: row.prior14_spend,
    conversions: row.prior14_conversions,
    revenue: row.prior14_revenue,
    impressions: row.prior14_impressions,
    clicks: row.prior14_clicks,
    linkClicks: row.prior14_link_clicks,
    linkClicksMissingDeliveredRows:
      row.prior14_link_clicks_missing_delivered_rows,
  });
  if (recent14 === null || prior14 === null) return null;
  return { cutoffDate, recent14, prior14 };
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
      /*
        Producer evidence for the ad-level fatigue contract, not resolver
        input: `toResolverInput` in jobs/ad-decisions-job.ts strips it before
        `decideCreative` runs.

        Withheld entirely for an ad with no finalized ad-day rows in the
        window. Such an ad already carries `performanceMetricsObserved:
        false`, and emitting two adjacent all-null bands for it would report
        "this window had no delivery" where the truth is "this ad has no
        observed metrics at all".
      */
      adBandEvidence:
        metricRowCount > 0 ? toAdBandEvidence(input.row) : null,
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

/**
 * The provider account a MEASURED read is scoped to, or `null` for the business.
 *
 * Blank is not an account. An empty string reaching the SQL as a scope would
 * match nothing at all and read as "this account has no evidence", which is a
 * different and much more dangerous answer than "no account was named".
 */
function normalizedProviderAccountId(value: string | null | undefined): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text === "" ? null : text;
}

/**
 * The `scope_id` an account-scoped calibration row carries.
 *
 * `'*'` is the business's whole Meta footprint. A named provider account is its
 * own scope, and `lib/creative-decision-engine/jobs/calibration-job.ts` writes
 * one such row per SELECTED Meta account beside the pooled `'*'` one, each
 * computed from that account's own rows. So a scoped read of an account the job
 * has covered is served from that row and is as stable for the day as the
 * pooled read has always been — on the same terms, including the staleness rule
 * in `readCalibrationFromTable`, which sends a pooled and a scoped read alike to
 * the runtime fallback when the row's own source freshness has aged out. A
 * scoped read of an account the job has NOT covered misses entirely, and
 * `readAccountScopeCalibrationMaterialisation` is how a caller tells that apart
 * from a row that says zero.
 */
function calibrationAccountScopeId(value: string | null | undefined): string {
  return normalizedProviderAccountId(value) ?? ACCOUNT_CALIBRATION_POOLED_SCOPE_ID;
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
  // D075: an absent_unconfirmed winner shadows the stale present row and is
  // not a seed; on complete receipts the caller's count guard then fails
  // closed instead of hydrating past the recorded scope exit.
  if (toStringOrNull(row.presence) !== "present") return null;
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
      // Capture floor = the run's ORIGINAL payload clock. The heartbeat
      // freshness clock (sourceCapturedAt) is strictly newer after a
      // coalesce and would filter out the manifest's own state rows.
      // D075: a delta manifest's carried members live in OLDER runs, so a
      // payload-clock floor would exclude them; the generation bound for a
      // delta is the reconstruction itself plus the count guard below.
      sourceCapturedAt:
        receipt.sourceManifestKind === "delta"
          ? null
          : (receipt.sourcePayloadCapturedAt ?? receipt.sourceCapturedAt),
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
  if (
    row.event_kind === "state" &&
    toStringOrNull(row.presence) !== "present"
  ) {
    // D075: the absent winner already out-competed the stale present row in
    // the as-of read; dropping it here leaves "no state evidence", never a
    // fabricated present state from null status fields.
    return;
  }
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
    providerAccountId?: string | null;
  }): Promise<AccountCalibration> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
      "account",
      calibrationAccountScopeId(input.providerAccountId),
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
    providerAccountId?: string | null;
  }): Promise<AccountCalibration | null> {
    const precomputed = await this.readCalibrationFromTable(
      input.businessId,
      input.asOf,
      "account",
      calibrationAccountScopeId(input.providerAccountId),
      input.campaignKind,
    );
    return precomputed.calibration;
  }

  async getAccountCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
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

  /**
   * Whether this account's own calibration scope exists in the warehouse, and
   * if it does not, whether any sibling account's does.
   *
   * Two indexed existence checks against
   * `engine_v3_account_calibration_daily`, in one statement. A throw is
   * reported as `unreadable` rather than as any kind of absence, because a
   * probe that failed proves nothing about what the table holds — and this
   * repository has a documented hazard (the pool's own query timeout, which
   * kills a read regardless of `statement_timeout`) that makes a failed probe
   * an ordinary event rather than a theoretical one.
   *
   * A caller that names NO account asks about the pooled `'*'` scope itself,
   * for which the per-account distinction is meaningless: it is materialised or
   * it is not.
   */
  async readAccountScopeCalibrationMaterialisation(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountScopeCalibrationMaterialisation> {
    const scopeId = calibrationAccountScopeId(input.providerAccountId);
    try {
      const rows = await getDb().query<Record<string, unknown>>(
        READ_ACCOUNT_SCOPE_MATERIALISATION_QUERY,
        [input.businessId, input.asOf, scopeId],
      );
      const row = rows[0];
      // A statement that returns no row at all answered nothing, and an
      // answer nobody gave is not the fact "absent".
      if (!row) return "unreadable";
      if (row.own_scope_present === true) return "materialised";
      if (scopeId === ACCOUNT_CALIBRATION_POOLED_SCOPE_ID) return "absent";
      return row.any_account_scope_present === true
        ? "absent"
        : "per_account_scopes_unwritten";
    } catch {
      return "unreadable";
    }
  }

  /**
   * Whether this business's warehouse rows belong to this account alone.
   *
   * Two seekable range probes in one statement. A throw is `unreadable` and is
   * never reported as `sole_account`, because the only thing a caller does with
   * `sole_account` is read the POOLED population in this account's name — a
   * claim a failed read cannot support.
   */
  async readBusinessAccountPopulationBreadth(input: {
    businessId: string;
    providerAccountId: string;
  }): Promise<BusinessAccountPopulationBreadth> {
    const account = normalizedProviderAccountId(input.providerAccountId);
    // A blank account names no population for the pooled rows to be equal TO,
    // so the question cannot be put. That is not the fact that the business
    // holds several accounts, and it is reported as its own answer.
    if (account === null) return "unreadable";
    try {
      const rows = await getDb().query<Record<string, unknown>>(
        READ_BUSINESS_ACCOUNT_POPULATION_BREADTH_QUERY,
        [input.businessId, account],
      );
      const row = rows[0];
      // A statement that returned no row answered nothing.
      if (!row) return "unreadable";
      return row.foreign_account_rows_present === true
        ? "multiple_accounts"
        : "sole_account";
    } catch {
      return "unreadable";
    }
  }

  async getAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
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
    providerAccountId?: string | null;
  }): Promise<AccountFunnelCalibration | null> {
    return this.readAccountFunnelCalibration(input);
  }

  async getAccountFunnelCalibrationAllKinds(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
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
    providerAccountId?: string | null;
  }): Promise<AccountFunnelCalibration | null> {
    let rows: FunnelCalibrationTableRow[];
    try {
      rows = await getDb().query<FunnelCalibrationTableRow>(
        READ_ACCOUNT_FUNNEL_CALIBRATION_QUERY,
        [
          input.businessId,
          input.asOf,
          input.campaignKind,
          calibrationAccountScopeId(input.providerAccountId),
        ],
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
      /*
        The account this fallback speaks for, or null for the business.

        A scoped caller lands here when the calibration job has not materialised
        that account's own scope — and landing here with an unfiltered statement
        is precisely how one account's creatives would set another's
        percentiles. The filter makes the fallback a live measurement of THIS
        account; what it cannot be is stable for the day, because it is
        recomputed from `meta_creative_daily` on every read.
      */
      providerAccountId?: string | null;
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
        normalizedProviderAccountId(input.providerAccountId),
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
    providerAccountId?: string | null;
  }): Promise<MetaAttributedAovResult> {
    /*
      ONE strict reader, with the account as a required authority input.

      Account binding, finalized/validated canonical facts and the historical
      knowledge cutoff all live in `computeMetaAttributedAov` rather than in a
      scoped copy kept here. Blank account scope fails closed to an empty sample.
    */
    return computeMetaAttributedAov({
      businessId: input.businessId,
      asOf: input.asOf,
      windowDays: input.windowDays,
      providerAccountId: normalizedProviderAccountId(input.providerAccountId),
      db: getDb(),
    });
  }
}

/**
 * A {@link CreativeDecisionDataSource} whose MEASURED reads are scoped to one
 * physical ad account, wrapped around any other data source.
 *
 * WHY IT EXISTS. `resolveAccountDecisionProfile` performs its own measured
 * reads — the account calibration, its kind-segmented variants, the funnel pack
 * and the strict Meta-attributed AOV authority. Calibration lookups default to
 * the business (`scope_id '*'`), so a caller that resolves the profile FOR one
 * account against a plain `WarehouseDataSource` can still get percentiles and
 * readiness computed from sibling accounts. Pinning the source also ensures the
 * strict AOV reader receives the physical provider account it must prove.
 *
 * The retention producer already avoids that by pinning the account into the
 * source it hands the resolver (`PinnedInputDataSource` in
 * `lib/meta/account-profile-output-producer.ts`). This is the same measurement
 * scope for callers that resolve live.
 *
 * WHAT IT DOES NOT SCOPE, ON PURPOSE. `getBusinessTargetPack` and
 * `getDecisionCalibrationProfile` are CONFIGURED commercial policy — one target
 * ROAS, one calibration profile for the business — and are forwarded
 * unchanged. `getCampaignCalibration` is already narrower than an account,
 * since a campaign belongs to exactly one. Everything else is forwarded
 * verbatim.
 *
 * A WRAPPER RATHER THAN A SUBCLASS, deliberately. Subclassing
 * `WarehouseDataSource` binds the base at class-definition time, so a caller
 * that had substituted its own data source would silently get the real
 * warehouse back; wrapping composes with whatever source the caller already
 * built. It also keeps the OPTIONAL readers honest: an optional method the base
 * does not implement is left undefined here too, because
 * `resolveAccountDecisionProfile` branches on their presence and a wrapper that
 * claimed them would answer for a source that cannot.
 *
 * `meta_aov_only` is the one bounded exception. A proven
 * `sole_account_pooled_rows` bootstrap must keep its precomputed calibration
 * and funnel rows pooled, because those rows are the stable measurement being
 * served. The strict Meta AOV reader still requires the physical account
 * binding even when that account is the whole population, so that mode scopes
 * only the AOV read. It cannot make a multi-account pooled AOV authoritative:
 * callers may select it only after the sole-account breadth proof succeeds.
 *
 * An explicit `providerAccountId` on a call still wins; the bound account is
 * the DEFAULT this source supplies when the caller names none.
 */
export class AccountScopedDataSource implements CreativeDecisionDataSource {
  readonly getAccountCalibrationByKind?: CreativeDecisionDataSource["getAccountCalibrationByKind"];
  readonly getAccountCalibrationAllKinds?: CreativeDecisionDataSource["getAccountCalibrationAllKinds"];
  readonly getAccountFunnelCalibrationByKind?: CreativeDecisionDataSource["getAccountFunnelCalibrationByKind"];
  readonly getAccountFunnelCalibrationAllKinds?: CreativeDecisionDataSource["getAccountFunnelCalibrationAllKinds"];
  readonly readAccountScopeCalibrationMaterialisation?: CreativeDecisionDataSource["readAccountScopeCalibrationMaterialisation"];
  readonly readBusinessAccountPopulationBreadth?: CreativeDecisionDataSource["readBusinessAccountPopulationBreadth"];

  constructor(
    private readonly base: CreativeDecisionDataSource,
    /** The physical account every measured read below is scoped to. */
    private readonly boundProviderAccountId: string,
    private readonly mode: "all_measured" | "meta_aov_only" = "all_measured",
  ) {
    const byKind = base.getAccountCalibrationByKind?.bind(base);
    if (byKind) {
      this.getAccountCalibrationByKind = (input) =>
        byKind(this.calibrationScope(input));
    }
    const allKinds = base.getAccountCalibrationAllKinds?.bind(base);
    if (allKinds) {
      this.getAccountCalibrationAllKinds = (input) =>
        allKinds(this.calibrationScope(input));
    }
    const funnelByKind = base.getAccountFunnelCalibrationByKind?.bind(base);
    if (funnelByKind) {
      this.getAccountFunnelCalibrationByKind = (input) =>
        funnelByKind(this.calibrationScope(input));
    }
    const funnelAllKinds = base.getAccountFunnelCalibrationAllKinds?.bind(base);
    if (funnelAllKinds) {
      this.getAccountFunnelCalibrationAllKinds = (input) =>
        funnelAllKinds(this.calibrationScope(input));
    }
    const materialisation =
      base.readAccountScopeCalibrationMaterialisation?.bind(base);
    if (materialisation) {
      this.readAccountScopeCalibrationMaterialisation = (input) =>
        materialisation(this.calibrationScope(input));
    }
    /*
      Forwarded with the bound account as the DEFAULT, like every other read
      here. This probe's `providerAccountId` is required rather than optional,
      so `scoped` cannot supply it from an absent value — an explicit account
      still wins, and a caller that names none gets the account this source is
      bound to.
    */
    const breadth = base.readBusinessAccountPopulationBreadth?.bind(base);
    if (breadth) {
      this.readBusinessAccountPopulationBreadth = (input) =>
        breadth(
          this.mode === "all_measured"
            ? {
                ...input,
                providerAccountId:
                  input.providerAccountId || this.boundProviderAccountId,
              }
            : input,
        );
    }
  }

  private scoped<T extends { providerAccountId?: string | null }>(input: T): T {
    return {
      ...input,
      providerAccountId: input.providerAccountId ?? this.boundProviderAccountId,
    };
  }

  private calibrationScope<T extends { providerAccountId?: string | null }>(
    input: T,
  ): T {
    return this.mode === "all_measured" ? this.scoped(input) : input;
  }

  // --- measured, and therefore scoped ---------------------------------------

  async getAccountCalibration(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountCalibration> {
    return this.base.getAccountCalibration(this.calibrationScope(input));
  }

  async getAccountFunnelCalibration(input: {
    businessId: string;
    asOf: string;
    providerAccountId?: string | null;
  }): Promise<AccountFunnelCalibration> {
    return this.base.getAccountFunnelCalibration(this.calibrationScope(input));
  }

  async getMetaAttributedAov(input: {
    businessId: string;
    asOf: string;
    windowDays?: number;
    providerAccountId?: string | null;
  }): Promise<MetaAttributedAovResult> {
    return this.base.getMetaAttributedAov(this.scoped(input));
  }

  // --- configured policy, or already narrower than an account ---------------

  async getBusinessTargetPack(input: {
    businessId: string;
    asOf?: string;
  }): Promise<BusinessTargetPack | null> {
    return this.base.getBusinessTargetPack(input);
  }

  async getDecisionCalibrationProfile(input: {
    businessId: string;
    channel: "meta";
    objectiveFamily: "sales";
  }): Promise<DecisionCalibrationProfileConfig | null> {
    return this.base.getDecisionCalibrationProfile(input);
  }

  async getCampaignCalibration(input: {
    businessId: string;
    asOf: string;
    campaignId: string;
  }): Promise<CampaignCalibrationLookup> {
    return this.base.getCampaignCalibration(input);
  }

  // --- forwarded verbatim ---------------------------------------------------

  async getCreativeInput(input: {
    creativeId: string;
    businessId: string;
    asOf: string;
  }): Promise<CreativeInput | null> {
    return this.base.getCreativeInput(input);
  }

  async listCreativeInputs(input: {
    businessId: string;
    asOf: string;
    creativeIds?: string[];
  }): Promise<CreativeInput[]> {
    return this.base.listCreativeInputs(input);
  }

  async getDataHealth(input: {
    businessId: string;
    asOf: string;
  }): Promise<DataHealth> {
    return this.base.getDataHealth(input);
  }

  async getLatestFunnelDiagnosis(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<FunnelDiagnosis | null> {
    return this.base.getLatestFunnelDiagnosis(input);
  }

  async getLatestOperatorResponse(input: {
    businessId: string;
    creativeId: string;
    asOf: string;
  }): Promise<OperatorResponseResult | null> {
    return this.base.getLatestOperatorResponse(input);
  }
}
