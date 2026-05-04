import { defaultBusinessConfig } from "../config";
import type { GateContext } from "../gates/types";
import type {
  AccountCalibration,
  BusinessConfig,
  CreativeInput,
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
    ...overrides,
  };
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
    ...overrides,
  };
}

export function makeGateContext(
  overrides: {
    input?: CreativeInput;
    businessConfig?: BusinessConfig;
    calibration?: AccountCalibration;
    gate?: Partial<
      Omit<GateContext, "input" | "businessConfig" | "calibration">
    >;
  } = {},
): GateContext {
  const businessConfig =
    overrides.businessConfig ?? defaultBusinessConfig("biz-1");

  return {
    input: overrides.input ?? makeCreativeInput(),
    businessConfig,
    calibration: overrides.calibration ?? makeAccountCalibration(),
    effectiveTargetRoas: businessConfig.globalDefaultTargetRoas,
    truthSource: "global_default",
    ratioToTarget: null,
    badges: [],
    confidenceBase: 75,
    confidenceDeltas: [],
    generatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides.gate,
  };
}
