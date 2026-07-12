import { defaultBusinessConfig } from "../config";
import type { GateContext } from "../gates/types";
import type {
  AccountDecisionProfile,
  AccountCalibration,
  AccountFunnelCalibration,
  BusinessConfig,
  CreativeInput,
  DataHealth,
  DataLayerHealth,
  EngineMultiplierSet,
  EngineThresholdSet,
} from "../types";

export function makeCreativeInput(
  overrides: Partial<CreativeInput> = {},
): CreativeInput {
  return {
    creativeId: "creative-1",
    creativeName: "Test Creative",
    businessId: "biz-1",
    campaignId: "campaign-1",
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
    lastSpendAt: "2026-05-04",
    policyReason: null,
    dataFreshnessHours: 6,
    fatigueStatus: "none",
    targetRoas: 2.2,
    breakevenRoas: 1.71,
    commercialTargetFreshness: "fresh",
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
    ...overrides,
  };
}

export function withCohort(
  cohort: CreativeInput["effectiveCohort"],
): Partial<CreativeInput> {
  return { effectiveCohort: cohort };
}

export function makeAccountCalibration(
  overrides: Partial<AccountCalibration> = {},
): AccountCalibration {
  return {
    businessId: "biz-1",
    computedAt: "2026-05-04T00:00:00.000Z",
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
    winnerPurchaseP50: 10,
    roasRatioP10: 0.4,
    roasRatioP25: 0.7,
    roasRatioP50: 1.0,
    roasRatioP75: 1.35,
    metaAovQuality: "ready",
    ...overrides,
  };
}

export function makeAccountFunnelCalibration(
  overrides: Partial<AccountFunnelCalibration> = {},
): AccountFunnelCalibration {
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
    ...overrides,
  };
}

type AccountDecisionProfileOverrides = Omit<
  Partial<AccountDecisionProfile>,
  "accountBaselines" | "funnelCalibration" | "multipliers" | "thresholds"
> & {
    accountBaselines?: AccountCalibration;
    funnelCalibration?: AccountFunnelCalibration;
    multipliers?: Partial<EngineMultiplierSet>;
    thresholds?: Partial<EngineThresholdSet>;
  };

export function makeAccountDecisionProfile(
  overrides: AccountDecisionProfileOverrides = {},
): AccountDecisionProfile {
  const {
    accountBaselines: accountBaselinesOverride,
    funnelCalibration: funnelCalibrationOverride,
    multipliers: multiplierOverrides,
    thresholds: thresholdOverrides,
    ...profileOverrides
  } = overrides;
  const accountBaselines =
    accountBaselinesOverride ?? makeAccountCalibration();
  const funnelCalibration =
    funnelCalibrationOverride ?? makeAccountFunnelCalibration();
  const multipliers: EngineMultiplierSet = {
    zeroConvBurner: 3,
    cutCandidate: 2,
    sustainedLoser: 3,
    lossBudget: 2,
    hardCut: 5,
    scalePurchase: 1,
    winnerMemory: 1.5,
    recentSample: 0.5,
    weakFunnelRate: 0.5,
    ...multiplierOverrides,
  };
  const thresholds: EngineThresholdSet = {
    zeroConvBurnerSpend: 200,
    cutCandidateSpend: 300,
    sustainedLoserSpend: 500,
    commercialMaturitySpend: 200,
    hardCutSpend: 1000,
    recentSampleMinSpend: 50,
    winnerMemoryMinSpend: 150,
    scaleMinPurchases: 10,
    winnerMemoryMinPurchases: 3,
    bottomQuartileRatio: 0.7,
    severeLoserRatio: 0.4,
    ...thresholdOverrides,
  };

  return {
    businessId: "biz-1",
    asOfDate: "2026-05-04",
    channel: "meta",
    objectiveFamily: "sales",
    preset: "balanced",
    presetSource: "default",
    spendUnit: 100,
    spendUnitSource: "target_cpa",
    spendUnitConfidence: "high",
    spendUnitEvidence: {
      targetCpa: 100,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: accountBaselines.metaAttributedAovMean90d,
      metaAttributedAovPurchaseCount90d:
        accountBaselines.metaAttributedAovPurchaseCount90d,
      metaAttributedRevenue90d: accountBaselines.metaAttributedRevenue90d,
      targetRoas: 2.2,
      breakEvenRoas: 1.71,
      accountCpaP50: accountBaselines.accountCpaP50,
      accountCpaSampleCount: accountBaselines.accountCpaSampleCount,
      warnings: [],
    },
    hardActionEligibility: {
      scale: true,
      cut: true,
      refresh: true,
      reason: null,
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: true,
      metaAovQuality: accountBaselines.metaAovQuality,
      thresholdQuality: "ready",
    },
    scope: { type: "account", id: "*" },
    ...profileOverrides,
    multipliers,
    thresholds,
    accountBaselines,
    funnelCalibration,
  };
}

export function makeDataLayerHealth(
  overrides: Partial<DataLayerHealth> = {},
): DataLayerHealth {
  return {
    asOfDate: "2026-05-04",
    computedAt: "2026-05-04T00:00:00.000Z",
    sourceFreshnessHours: 0,
    staleTier: "none",
    fallbackMode: "precomputed",
    note: null,
    ...overrides,
  };
}

export function makeDataHealth(
  overrides: Partial<DataHealth> = {},
): DataHealth {
  const calibration = overrides.calibration ?? makeDataLayerHealth();
  const lifecycle = overrides.lifecycle ?? makeDataLayerHealth();
  const decisions = overrides.decisions ?? makeDataLayerHealth();
  const staleTiers = [
    calibration.staleTier,
    lifecycle.staleTier,
    decisions.staleTier,
  ];
  const worstTier = staleTiers.includes("disabled")
    ? "disabled"
    : staleTiers.includes("warning")
      ? "warning"
      : "none";

  return {
    calibration,
    lifecycle,
    decisions,
    worstTier,
    degraded: worstTier === "disabled",
    ...overrides,
  };
}

export function makeGateContext(
  overrides: {
    input?: CreativeInput;
    businessConfig?: BusinessConfig;
    calibration?: AccountCalibration;
    profile?: AccountDecisionProfile;
    dataHealth?: DataHealth;
    gate?: Partial<Omit<GateContext, "input" | "profile">>;
  } = {},
): GateContext {
  const businessConfig =
    overrides.businessConfig ?? defaultBusinessConfig("biz-1");
  const calibration = overrides.calibration ?? makeAccountCalibration();
  const profile =
    overrides.profile ??
    makeAccountDecisionProfile({
      accountBaselines: {
        ...calibration,
        matureSpendP50: 300,
        winnerPurchaseP50: 10,
      },
      thresholds: {
        recentSampleMinSpend: businessConfig.recentSampleMinSpend,
        scaleMinPurchases: 10,
        hardCutSpend: 1000,
      },
    });

  return {
    input: overrides.input ?? makeCreativeInput(),
    profile,
    dataHealth: overrides.dataHealth,
    effectiveTargetRoas: businessConfig.globalDefaultTargetRoas,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas: [],
    blockers: [],
    generatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides.gate,
  };
}
