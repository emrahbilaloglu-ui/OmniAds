import { describe, expect, it } from "vitest";
import {
  applyCommercialStopLossAovAuthority,
  isAccountAovRevenueArithmeticConsistent,
  resolveAccountDecisionProfile,
} from "../account-decision-profile";
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
    private readonly profileConfig: DecisionCalibrationProfileConfig | null = null,
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
    private readonly liveMetaAov: {
      aovMean: number | null;
      purchaseCount: number;
      totalRevenue: number;
      windowStart: string;
      windowEnd: string;
    } | null = null,
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
    return this.targetPack
      ? {
          ...this.targetPack,
          updatedAt: this.targetPack.updatedAt ?? "2026-05-04T02:00:00.000Z",
          freshness: this.targetPack.freshness ?? "fresh",
        }
      : null;
  }

  async getDecisionCalibrationProfile(): Promise<DecisionCalibrationProfileConfig | null> {
    return this.profileConfig;
  }

  async getMetaAttributedAov() {
    return this.liveMetaAov ?? {
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
  it("validates account-AOV arithmetic without a fixed currency minor-unit tolerance", () => {
    expect(
      isAccountAovRevenueArithmeticConsistent({
        meanAov: 100 / 3,
        purchaseCount: 3,
        totalRevenue: 100,
      }),
    ).toBe(true);
    expect(
      isAccountAovRevenueArithmeticConsistent({
        meanAov: 0.001,
        purchaseCount: 20,
        totalRevenue: 0.025,
      }),
    ).toBe(false);
  });

  it("applies physical-account AOV as a Cut-only profile overlay", async () => {
    const targetPack: BusinessTargetPack = {
      targetCpa: null,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.8,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced",
      updatedAt: "2026-05-04T02:00:00.000Z",
      freshness: "fresh",
    };
    const baseProfile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource(
        targetPack,
        makeAccountCalibration({
          metaAttributedAovMean90d: 50,
          metaAttributedAovPurchaseCount90d: 5,
          metaAttributedRevenue90d: 250,
          metaAovQuality: "low_sample",
        }),
      ),
      flags: makeFlags({ shadowOnly: false }),
    });
    const overlaidProfile = applyCommercialStopLossAovAuthority({
      profile: baseProfile,
      targetPack,
      attributionAovAdjustmentMultiplier: 1,
      shadowOnly: false,
      authority: {
        meanAov: 100,
        purchaseCount: 20,
        totalRevenue: 2_000,
      },
    });
    const nonCutProjection = (profile: typeof baseProfile) => {
      const {
        commercialStopLossSpendUnit: _commercialStopLossSpendUnit,
        commercialStopLossThresholds: _commercialStopLossThresholds,
        commercialStopLossCanonicalHardActionEligibility:
          _commercialStopLossCanonicalHardActionEligibility,
        hardActionEligibility,
        ...canonicalProfile
      } = profile;
      return {
        canonicalProfile,
        scale: hardActionEligibility.scale,
        scaleReason: hardActionEligibility.reasons?.scale,
        refresh: hardActionEligibility.refresh,
        refreshReason: hardActionEligibility.reasons?.refresh,
      };
    };

    expect(nonCutProjection(overlaidProfile)).toEqual(
      nonCutProjection(baseProfile),
    );
    expect(overlaidProfile.commercialStopLossSpendUnit?.spendUnit).toBeCloseTo(
      100 / 2.2,
      8,
    );
    expect(overlaidProfile.commercialStopLossThresholds).not.toEqual(
      baseProfile.thresholds,
    );
    expect(
      overlaidProfile.commercialStopLossCanonicalHardActionEligibility,
    ).toEqual(baseProfile.hardActionEligibility);
    expect(overlaidProfile.hardActionEligibility.cut).toBe(true);
  });

  /*
    ── ROUND 9 ITEM 2: THE PROFILE OBEYS ITS OWN CUTOFF ──────────────────────

    `resolveAccountDecisionProfile` passed no cutoff into
    `resolveSpendUnitProfile` / `resolveHardActionEligibility`, and the check
    there asked whether `updatedAt` PARSED. So a target pack saved after the day
    being reconstructed made every hard action eligible — a point-in-time
    profile granting authority from evidence that did not exist yet.

    `asOf: "2026-05-04"` widens to the deterministic cutoff
    `2026-05-04T03:00:00.000Z`, the same rule the historical pack reader
    applies. These cases drive the real resolver across that boundary.
  */
  const CUTOFF_PACK_ASOF = "2026-05-04";

  function packAt(updatedAt: string | null): BusinessTargetPack {
    return {
      targetCpa: null,
      targetRoas: 2.2,
      breakEvenCpa: null,
      breakEvenRoas: 1.7,
      operatorAovAssumption: null,
      defaultRiskPosture: "balanced",
      updatedAt,
      freshness: "fresh",
    } as BusinessTargetPack;
  }

  const readyCalibrationByKind = () => {
    const ready = makeAccountCalibration({
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      metaAovQuality: "ready" as const,
    });
    return {
      all: { ...ready, campaignKind: "all" as const },
      main: { ...ready, campaignKind: "main" as const },
      test: null,
      mixed: null,
    };
  };

  const profileWithPackAt = async (
    updatedAt: string,
    asOf = CUTOFF_PACK_ASOF,
  ) =>
    resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf,
      dataSource: new ProfileDataSource(
        packAt(updatedAt),
        makeAccountCalibration({
          metaAttributedAovMean90d: 50,
          metaAttributedAovPurchaseCount90d: 42,
          metaAttributedRevenue90d: 2100,
          metaAovQuality: "ready",
        }),
        null,
        { calibration: null, matureCreativeCount: null },
        readyCalibrationByKind(),
      ),
      flags: makeFlags({ shadowOnly: false }),
    });

  it("keeps every hard action eligible for a pack in force AT the cutoff", async () => {
    // The control. Without it the refusals below would be satisfied by a
    // profile that simply never grants anything.
    const profile = await profileWithPackAt("2026-05-04T03:00:00.000Z");
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
    });
    expect(profile.spendUnitSource).toBe("meta_derived_aov");
  });

  it("lets cutoff-safe account AOV override a populated legacy calibration under Target ROAS", async () => {
    const unsafeLegacy = makeAccountCalibration({
      metaAttributedAovMean90d: 999,
      metaAttributedAovPurchaseCount90d: 99,
      metaAttributedRevenue90d: 98_901,
      metaAovQuality: "ready",
    });
    const unsafeLegacyByKind = {
      all: { ...unsafeLegacy, campaignKind: "all" as const },
      main: { ...unsafeLegacy, campaignKind: "main" as const },
      test: null,
      mixed: null,
    };
    const liveMetaAov = {
      aovMean: 58,
      purchaseCount: 20,
      totalRevenue: 1_160,
      windowStart: "2026-02-05",
      windowEnd: "2026-05-04",
    };
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: CUTOFF_PACK_ASOF,
      dataSource: new ProfileDataSource(
        packAt("2026-05-04T03:00:00.000Z"),
        unsafeLegacy,
        null,
        { calibration: null, matureCreativeCount: null },
        unsafeLegacyByKind,
        null,
        liveMetaAov,
      ),
      flags: makeFlags({ shadowOnly: false }),
    });

    expect(profile.spendUnitSource).toBe("meta_derived_aov");
    expect(profile.spendUnit).toBeCloseTo(58 / 2.2, 10);
    expect(profile.spendUnit).not.toBeCloseTo(999 / 2.2, 10);
    expect(profile.hardActionEligibility.scale).toBe(true);
    expect(profile.hardActionEligibilityByKind?.main?.scale).toBe(true);
  });

  it("treats an empty cutoff-safe account AOV as HOLD instead of reviving legacy calibration", async () => {
    const unsafeLegacy = makeAccountCalibration({
      metaAttributedAovMean90d: 999,
      metaAttributedAovPurchaseCount90d: 99,
      metaAttributedRevenue90d: 98_901,
      metaAovQuality: "ready",
    });
    const unsafeLegacyByKind = {
      all: { ...unsafeLegacy, campaignKind: "all" as const },
      main: { ...unsafeLegacy, campaignKind: "main" as const },
      test: null,
      mixed: null,
    };
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: CUTOFF_PACK_ASOF,
      dataSource: new ProfileDataSource(
        packAt("2026-05-04T03:00:00.000Z"),
        unsafeLegacy,
        null,
        { calibration: null, matureCreativeCount: null },
        unsafeLegacyByKind,
        null,
        {
          aovMean: null,
          purchaseCount: 0,
          totalRevenue: 0,
          windowStart: "2026-02-05",
          windowEnd: "2026-05-04",
        },
      ),
      flags: makeFlags({ shadowOnly: false }),
    });

    expect(profile.spendUnitSource).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
    expect(profile.hardActionEligibilityByKind?.main).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("makes EVERY hard action ineligible one millisecond after the cutoff", async () => {
    const profile = await profileWithPackAt("2026-05-04T03:00:00.001Z");
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("makes every hard action ineligible one microsecond after an exact cutoff", async () => {
    const profile = await profileWithPackAt(
      "2026-05-04T03:00:00.000900Z",
      "2026-05-04T03:00:00.000100Z",
    );
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
    expect(profile.hardActionEligibilityByKind?.main).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("keeps every hard action eligible at an offset-equivalent exact cutoff", async () => {
    const profile = await profileWithPackAt(
      "2026-05-04T05:00:00.0009+02:00",
      "2026-05-04T03:00:00.000900Z",
    );
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
    });
    expect(profile.hardActionEligibilityByKind?.main?.scale).toBe(true);
  });

  it("applies the same cutoff to the PER-KIND profiles", async () => {
    /*
      The canonical profile and the per-kind profiles are resolved by separate
      calls. Threading the cutoff into one and not the other would let a
      campaign-kind lane act on a pack the account-level lane had just refused —
      which is why `asOfCutoffMs` is a REQUIRED field on both callees rather
      than an optional one.
    */
    const inForce = await profileWithPackAt("2026-05-04T02:59:59.999Z");
    const afterCutoff = await profileWithPackAt("2026-05-04T03:00:00.001Z");
    expect(inForce.hardActionEligibilityByKind?.main).toMatchObject({
      cut: true,
    });
    expect(afterCutoff.hardActionEligibilityByKind?.main).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

  it("fails closed when no deterministic cutoff can be derived at all", async () => {
    /*
      Never a wall clock. An `asOf` this code cannot read is an absent cutoff,
      and an absent cutoff cannot authorize anything.
    */
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: "2026-02-30",
      dataSource: new ProfileDataSource(
        packAt("2026-02-01T00:00:00.000Z"),
        makeAccountCalibration({
          metaAttributedAovMean90d: 50,
          metaAttributedAovPurchaseCount90d: 42,
          metaAttributedRevenue90d: 2100,
          metaAovQuality: "ready",
        }),
      ),
      flags: makeFlags({ shadowOnly: false }),
    });
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
  });

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

  it("keeps an old but timestamp-trusted target fully eligible", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000501",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: 100,
        targetRoas: 2.2,
        breakEvenCpa: 130,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
        freshness: "stale",
        updatedAt: "2026-03-01T00:00:00.000Z",
      }),
      flags: makeFlags({ shadowOnly: false }),
    });

    /*
      RE-PINNED for the reordered ladder. This pack carries a Target ROAS of
      2.2 alongside its legacy Target CPA of 100, so the unit is now the
      account's Meta-attributed AOV (50) over that ratio and its confidence is
      the sampled `medium` rather than the configured `high`. What this test is
      actually about — an old but timestamp-TRUSTED target staying fully
      eligible, and saying it is stale — is unchanged, and is what the
      assertions below still measure.
    */
    expect(profile.spendUnit).toBeCloseTo(50 / 2.2, 10);
    expect(profile.spendUnit).not.toBe(100);
    expect(profile.spendUnitConfidence).toBe("medium");
    expect(profile.spendUnitEvidence.warnings).toContain(
      "commercial_target_stale",
    );
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });
    expect(profile.quality).toMatchObject({
      commercialTruthReady: true,
      commercialTruthFreshness: "stale",
      thresholdQuality: "ready",
    });
  });

  it("requires action-specific ROAS anchors even when target CPA is fresh", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000511",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: 100,
        targetRoas: null,
        breakEvenCpa: 130,
        breakEvenRoas: null,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({ shadowOnly: false }),
    });

    expect(profile.spendUnitSource).toBe("target_cpa");
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: true,
      reasons: {
        scale: "valid explicit target ROAS is required for scale authority",
        cut: "valid explicit break-even or target ROAS is required for cut authority",
      },
    });
    expect(profile.quality.commercialTruthReady).toBe(false);
  });

  it("lets a growth target anchor cut without inventing a loss boundary", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000512",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: 100,
        targetRoas: 2.2,
        breakEvenCpa: null,
        breakEvenRoas: null,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({ shadowOnly: false }),
    });

    // A configured Target ROAS plus the canonical Meta AOV is a sufficient
    // Cut anchor: it sizes the loss-budget spend unit. Requiring a second
    // operator-typed ratio blocked every Cut on accounts that configure only
    // a Target ROAS.
    expect(profile.hardActionEligibility).toMatchObject({
      scale: true,
      cut: true,
      refresh: true,
    });
    expect(profile.hardActionEligibility.reasons?.cut).toBeNull();
    // What must NOT happen: a synthetic break-even. With none configured the
    // resolver's economic strip (`cut-policy.hasExplicitBreakEven`) stays
    // unreachable and Cut keeps using the account-relative boundary.
    expect(profile.spendUnitEvidence.breakEvenRoas).toBeNull();
  });

  it("does not let a loss boundary authorize scale", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000513",
      asOf: "2026-05-04",
      dataSource: new ProfileDataSource({
        targetCpa: 100,
        targetRoas: null,
        breakEvenCpa: 130,
        breakEvenRoas: 1.7,
        operatorAovAssumption: null,
        defaultRiskPosture: "balanced",
      }),
      flags: makeFlags({ shadowOnly: false }),
    });

    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: true,
      refresh: true,
    });
    expect(profile.hardActionEligibility.reasons?.scale).toBe(
      "valid explicit target ROAS is required for scale authority",
    );
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

  it("keeps refresh ineligible when commercial threshold confidence is low", async () => {
    const profile = await resolveAccountDecisionProfile({
      businessId: "00000000-0000-4000-8000-000000000510",
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
        makeAccountCalibration({
          accountCpaP50: 58,
          accountCpaSampleCount: 3,
          metaAttributedAovMean90d: 50,
          metaAttributedAovPurchaseCount90d: 6,
          metaAttributedRevenue90d: 300,
          metaAovQuality: "low_sample",
        }),
      ),
      flags: makeFlags({
        businessId: "00000000-0000-4000-8000-000000000510",
      }),
    });

    /*
      ROUND 6: a six-purchase sample under a Target ROAS builds no unit at all,
      so the confidence is the hold rather than a `low` attached to a number.
      Everything this case is actually about — all three hard actions refused,
      and the refresh reason naming the confidence — is unchanged.
    */
    expect(profile.spendUnitConfidence).toBe("insufficient");
    expect(profile.spendUnit).toBeNull();
    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
    });
    expect(profile.hardActionEligibility.reasons?.refresh).toContain(
      "confidence",
    );
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

    expect(profile.hardActionEligibility).toMatchObject({
      scale: false,
      cut: false,
      refresh: false,
      reason: "shadow_only",
      reasons: {
        scale: "shadow_only",
        cut: "shadow_only",
        refresh: "shadow_only",
      },
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
