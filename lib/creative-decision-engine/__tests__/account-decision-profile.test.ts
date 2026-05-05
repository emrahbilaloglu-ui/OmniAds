import { describe, expect, it } from "vitest";
import { resolveAccountDecisionProfile } from "../account-decision-profile";
import type {
  BusinessTargetPack,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "../data-source";
import type { CreativeInput, DataHealth, FunnelDiagnosis } from "../types";
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
  ) {}

  async getCreativeInput(): Promise<CreativeInput | null> {
    return null;
  }

  async getAccountCalibration() {
    return this.calibration;
  }

  async getAccountFunnelCalibration() {
    return makeAccountFunnelCalibration();
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
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
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
    expect(profile.spendUnit).toBeCloseTo(50 / 2.2, 5);
    expect(profile.preset).toBe("balanced");
    expect(profile.thresholds.zeroConvBurnerSpend).toBeCloseTo(
      (50 / 2.2) * 3,
      5,
    );
    expect(profile.hardActionEligibility.scale).toBe(true);
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
      hardCut: 5,
      scaleEvidence: 3,
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBeCloseTo(50 / 2.2, 5);
  });
});
