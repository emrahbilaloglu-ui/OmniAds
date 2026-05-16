import { describe, expect, it } from "vitest";
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import type {
  BusinessTargetPack,
  CampaignCalibrationLookup,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "../data-source";
import type {
  AccountCalibration,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  CreativeInput,
  DataHealth,
  FunnelDiagnosis,
} from "../types";
import type { OperatorResponseResult } from "../operator-response-detection";
import {
  makeAccountCalibration,
  makeAccountFunnelCalibration,
  makeDataHealth,
} from "./helpers";
import type { EngineV3Flags } from "../feature-flags";

class ProfileDataSource implements CreativeDecisionDataSource {
  constructor(
    private readonly targetPack: BusinessTargetPack | null,
    private readonly calibration = makeAccountCalibration(),
    private readonly profileConfig: DecisionCalibrationProfileConfig | null =
      null,
    private readonly campaignLookup: CampaignCalibrationLookup = {
      calibration: null,
      matureCreativeCount: null,
    },
    private readonly accountBaselinesByKind: Record<
      CalibrationCampaignKind,
      AccountCalibration | null
    > | null = null,
    private readonly funnelCalibrationByKind: Record<
      CalibrationCampaignKind,
      AccountFunnelCalibration | null
    > | null = null,
  ) {}

  async getCreativeInput(): Promise<CreativeInput | null> {
    return null;
  }

  async getAccountCalibration() {
    return this.calibration;
  }

  async getAccountCalibrationAllKinds() {
    return (
      this.accountBaselinesByKind ?? {
        all: { ...this.calibration, campaignKind: "all" },
        main: null,
        test: null,
        mixed: null,
      }
    );
  }

  async getCampaignCalibration() {
    return this.campaignLookup;
  }

  async getAccountFunnelCalibration() {
    return makeAccountFunnelCalibration();
  }

  async getAccountFunnelCalibrationAllKinds() {
    return (
      this.funnelCalibrationByKind ?? {
        all: makeAccountFunnelCalibration({ campaignKind: "all" }),
        main: null,
        test: null,
        mixed: null,
      }
    );
  }

  async listCreativeInputs(): Promise<CreativeInput[]> {
    return [];
  }

  async getDataHealth(): Promise<DataHealth> {
    return makeDataHealth();
  }

  async getLatestFunnelDiagnosis(): Promise<FunnelDiagnosis | null> {
    return null;
  }

  async getLatestOperatorResponse(): Promise<OperatorResponseResult | null> {
    return null;
  }

  async getBusinessTargetPack(): Promise<BusinessTargetPack | null> {
    return this.targetPack;
  }

  async getDecisionCalibrationProfile(): Promise<DecisionCalibrationProfileConfig | null> {
    return this.profileConfig;
  }

  async getMetaAttributedAov() {
    return {
      aovMean: this.calibration.metaAttributedAovMean90d,
      purchaseCount: this.calibration.metaAttributedAovPurchaseCount90d,
      totalRevenue: this.calibration.metaAttributedRevenue90d,
      windowStart: "2026-02-05",
      windowEnd: "2026-05-04",
    };
  }
}

function makeFlags(overrides: Partial<EngineV3Flags> = {}): EngineV3Flags {
  return {
    businessId: "biz-1",
    enabled: true,
    surfaceVisible: false,
    shadowOnly: false,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
    ...overrides,
  };
}

describe("resolveAccountDecisionProfile", () => {
  it("builds a production-like Meta-derived profile with populated thresholds", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: null,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000501",
      }),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.scope).toEqual({ type: "account", id: "*" });
    expect(profile.spendUnit).toBeCloseTo(50 / 2.2, 5);
    expect(profile.preset).toBe("balanced");
    expect(profile.thresholds.zeroConvBurnerSpend).toBeCloseTo(
      (50 / 2.2) * 3,
      5,
    );
    expect(profile.hardActionEligibility.scale).toBe(true);
  });

  it("precomputes kind-segmented calibration while keeping canonical thresholds unchanged", async () => {
    const accountCalibration = makeAccountCalibration({
      roasRatioP10: 0.4,
      roasRatioP25: 0.7,
      winnerPurchaseP50: 10,
    });
    const mainCalibration = makeAccountCalibration({
      campaignKind: "main",
      roasRatioP10: 0.01,
      roasRatioP25: 0.02,
      winnerPurchaseP50: 1,
    });

    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000509",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource(
        {
          targetCpa: null,
          targetRoas: 2.2,
          breakEvenCpa: null,
          breakEvenRoas: 1.7,
          operatorAovAssumption: null,
          defaultRiskPosture: "balanced",
        },
        accountCalibration,
        null,
        { calibration: null, matureCreativeCount: null },
        {
          all: { ...accountCalibration, campaignKind: "all" },
          main: mainCalibration,
          test: null,
          mixed: null,
        },
        {
          all: makeAccountFunnelCalibration({ campaignKind: "all" }),
          main: makeAccountFunnelCalibration({ campaignKind: "main" }),
          test: null,
          mixed: null,
        },
      ),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000509",
      }),
    });

    expect(profile.accountBaselinesByKind?.main?.roasRatioP25).toBe(0.02);
    expect(profile.thresholdsByKind?.main?.bottomQuartileRatio).toBe(0.02);
    expect(profile.thresholdsByKind?.main?.scaleMinPurchases).toBe(1);
    expect(profile.spendUnitByKind?.main?.spendUnitSource).toBe(
      "meta_derived_aov",
    );
    expect(profile.funnelCalibrationByKind?.main?.campaignKind).toBe("main");
    expect(profile.accountBaselines.roasRatioP25).toBe(0.7);
    expect(profile.thresholds.bottomQuartileRatio).toBe(0.7);
    expect(profile.thresholds.severeLoserRatio).toBe(0.4);
  });

  it("uses campaign ratio percentiles when a campaign-scoped row has enough mature creatives", async () => {
    const accountCalibration = makeAccountCalibration({
      matureSpendP50: 300,
      winnerPurchaseP50: 10,
      roasRatioP10: 0.4,
      roasRatioP25: 0.7,
      roasRatioP50: 1,
      roasRatioP75: 1.35,
    });
    const campaignCalibration = makeAccountCalibration({
      matureCreativeCount: 8,
      matureSpendP50: 100,
      winnerPurchaseP50: 2,
      roasRatioP10: 0.2,
      roasRatioP25: 0.45,
      roasRatioP50: 0.75,
      roasRatioP75: 1.1,
    });

    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000505",
      asOf: "2026-05-04",
      campaignId: "campaign-test",
      dataSource: new ProfileDataSource(
        {
          targetCpa: null,
          targetRoas: 2.2,
          breakEvenCpa: null,
          breakEvenRoas: 1.7,
          operatorAovAssumption: null,
          defaultRiskPosture: "balanced",
        },
        accountCalibration,
        null,
        { calibration: campaignCalibration, matureCreativeCount: 8 },
      ),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000505",
      }),
    });

    expect(profile.scope).toEqual({ type: "campaign", id: "campaign-test" });
    expect(profile.accountBaselines.roasRatioP10).toBe(0.2);
    expect(profile.accountBaselines.roasRatioP25).toBe(0.45);
    expect(profile.accountBaselines.roasRatioP50).toBe(0.75);
    expect(profile.accountBaselines.roasRatioP75).toBe(1.1);
    expect(profile.accountBaselines.matureSpendP50).toBe(300);
    expect(profile.thresholds.scaleMinPurchases).toBe(10);
    expect(profile.thresholds.bottomQuartileRatio).toBe(0.45);
  });

  it("falls back to account scope when a campaign row is missing", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000506",
      asOf: "2026-05-04",
      campaignId: "campaign-missing",
      dataSource: new ProfileDataSource(
        {
          targetCpa: null,
          targetRoas: 2.2,
          breakEvenCpa: null,
          breakEvenRoas: 1.7,
          operatorAovAssumption: null,
          defaultRiskPosture: "balanced",
        },
        makeAccountCalibration(),
        null,
        { calibration: null, matureCreativeCount: null },
      ),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000506",
      }),
    });

    expect(profile.scope).toEqual({
      type: "account",
      id: "*",
      fallbackReason: "campaign_calibration_missing",
    });
    expect(profile.thresholds.bottomQuartileRatio).toBe(0.7);
  });

  it("falls back to account scope when campaign sample is below threshold", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000507",
      asOf: "2026-05-04",
      campaignId: "campaign-small",
      dataSource: new ProfileDataSource(
        {
          targetCpa: null,
          targetRoas: 2.2,
          breakEvenCpa: null,
          breakEvenRoas: 1.7,
          operatorAovAssumption: null,
          defaultRiskPosture: "balanced",
        },
        makeAccountCalibration(),
        null,
        {
          calibration: makeAccountCalibration({ matureCreativeCount: 7 }),
          matureCreativeCount: 7,
        },
      ),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000507",
      }),
    });

    expect(profile.scope).toEqual({
      type: "account",
      id: "*",
      fallbackReason: "campaign_sample_below_threshold",
    });
    expect(profile.thresholds.bottomQuartileRatio).toBe(0.7);
  });

  it("uses business_engine_v3_flags preset override before calibration profile and target pack posture", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000504",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: null,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "aggressive",
      }),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000504",
        presetOverride: "conservative",
        source: {
          enabled: "env",
          surfaceVisible: "env",
          shadowOnly: "env",
          presetOverride: "business_override",
        },
      }),
    });

    expect(profile.preset).toBe("conservative");
    expect(profile.presetSource).toBe("business_engine_v3_flags_override");
  });

  it("keeps cold-start accounts in insufficient soft-only mode", async () => {
    const coldCalibration = makeAccountCalibration({
      matureCreativeCount: 0,
      roasP75: null,
      roasP60: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
      metaAovQuality: "unavailable",
      matureSpendP50: null,
      matureSpendP75: null,
      winnerSpendP25: null,
      winnerSpendP50: null,
      winnerPurchaseP50: null,
      roasRatioP10: null,
      roasRatioP25: null,
      roasRatioP50: null,
      roasRatioP75: null,
    });

    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000502",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource(null, coldCalibration),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000502",
      }),
    });

    expect(profile.spendUnitSource).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(profile.thresholds.zeroConvBurnerSpend).toBeNull();
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
    expect(profile.quality.thresholdQuality).toBe("insufficient");
  });

  it("resolves TheSwaf-like target ROAS and Meta AOV to a ~$23 spend unit", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: null,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({
        businessId: "172d0ab8-495b-4679-a4c6-ffa404c389d3",
      }),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBeCloseTo(22.73, 2);
  });

  it("forces hard actions off in shadow mode without changing the profile inputs", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000503",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: null,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000503",
        shadowOnly: true,
      }),
    });

    expect(profile.hardActionEligibility).toEqual({
      scale: false,
      cut: false,
      refresh: false,
      reason: "shadow_only",
    });
    expect(profile.preset).toBe("balanced");
    expect(profile.multipliers).toMatchObject({
      zeroConvBurner: 3,
      lossBudget: 2,
      hardCut: 5,
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBeCloseTo(50 / 2.2, 5);
  });
});
